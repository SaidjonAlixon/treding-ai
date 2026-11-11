#!/usr/bin/env python3
"""Yangilik + mening TF tahlilim + OpenAI prognoz → faqat mos kelganda lot."""

from __future__ import annotations

import json
import math
import os
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import MetaTrader5 as mt5

PATH = os.environ.get("EXNESS_MT5_PATH", r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe")
LOGIN = int(os.environ.get("EXNESS_MT5_LOGIN", "0") or 0)
PASSWORD = os.environ.get("EXNESS_MT5_PASSWORD", "")
SERVER = os.environ.get("EXNESS_MT5_SERVER", "Exness-MT5Trial15")
MAGIC = 261450
TARGET_PROFIT = 40.0  # shu sessiyada foyda maqsadi
SYMBOLS = {
    "BTCUSDm": "BTCUSDT",
    "XAUUSDm": "XAUUSD",
    "ETHUSDm": "ETHUSD",
}


def load_openai_key() -> str:
    root = Path(__file__).resolve().parents[1]
    for name in (".env.local", "artifacts/api-server/.env", "artifacts/smartgold-bitcoin-trader/.env.local"):
        p = root / name
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("OPENAI_API_KEY", "").strip()


def filling_of(info) -> int:
    m = int(info.filling_mode)
    if m & 2:
        return mt5.ORDER_FILLING_IOC
    if m & 1:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


def ema(vals: list[float], n: int) -> float:
    k = 2 / (n + 1)
    e = vals[0]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
    return e


def rsi(closes: list[float], n: int = 14) -> float:
    ch = [closes[i] - closes[i - 1] for i in range(-n, 0)]
    up = sum(x for x in ch if x > 0) / n
    dn = abs(sum(x for x in ch if x < 0)) / n
    if dn == 0:
        return 100.0
    return 100 - 100 / (1 + up / dn)


def fetch_calendar() -> list[dict]:
    url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
    req = urllib.request.Request(url, headers={"User-Agent": "MizanTrader/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        rows = json.loads(resp.read().decode())
    now = datetime.now(timezone.utc)
    out = []
    for row in rows:
        try:
            when = datetime.fromisoformat(str(row.get("date", "")).replace("Z", "+00:00"))
        except Exception:
            continue
        impact = str(row.get("impact", "Low")).lower()
        if impact == "holiday":
            continue
        mins = (when - now).total_seconds() / 60
        if mins < -200 or mins > 60 * 48:
            continue
        if impact not in ("high", "medium"):
            continue
        out.append(
            {
                "title": str(row.get("title", "")),
                "currency": str(row.get("country", "")),
                "impact": impact,
                "when": when.isoformat(),
                "minutesUntil": round(mins),
            }
        )
    out.sort(key=lambda x: x["minutesUntil"])
    return out[:12]


def my_ta(symbol: str) -> dict | None:
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    info = mt5.symbol_info(symbol)
    if not tick or not info or tick.bid <= 0:
        return None
    frames = {}
    for name, tf in (
        ("M5", mt5.TIMEFRAME_M5),
        ("M15", mt5.TIMEFRAME_M15),
        ("H1", mt5.TIMEFRAME_H1),
    ):
        rates = mt5.copy_rates_from_pos(symbol, tf, 0, 80)
        if rates is None:
            return None
        closes = [float(x["close"]) for x in rates]
        e9, e21 = ema(closes[-30:], 9), ema(closes[-50:], 21)
        atr = sum(float(rates[i]["high"]) - float(rates[i]["low"]) for i in range(-14, 0)) / 14
        frames[name] = {
            "trend": "UP" if e9 > e21 else "DOWN",
            "rsi": round(rsi(closes), 1),
            "mom": round(closes[-1] - closes[-8], 4),
            "atr": atr,
            "last": closes[-1],
        }
    m5, m15, h1 = frames["M5"], frames["M15"], frames["H1"]
    side = None
    conf = 0
    why = ""
    if m5["trend"] == m15["trend"] == h1["trend"]:
        side = "BUY" if m5["trend"] == "UP" else "SELL"
        conf = 84
        why = "3TF bir xil"
    elif h1["trend"] == m15["trend"]:
        side = "BUY" if h1["trend"] == "UP" else "SELL"
        # M5 bounce against H1: only if mom turning with H1
        if side == "SELL" and m5["mom"] <= 0:
            conf = 76
            why = "H1+M15 DOWN, M5 mom pastga"
        elif side == "BUY" and m5["mom"] >= 0:
            conf = 76
            why = "H1+M15 UP, M5 mom tepaga"
        else:
            conf = 62
            why = "H1+M15 trend, M5 hali qarshi bounce"
    elif h1["rsi"] <= 28 and m5["trend"] == "UP" and m15["trend"] == "UP":
        side, conf, why = "BUY", 74, "H1 oversold bounce"
    elif h1["rsi"] >= 72 and m5["trend"] == "DOWN" and m15["trend"] == "DOWN":
        side, conf, why = "SELL", 74, "H1 overbought fade"
    if side == "BUY" and m5["rsi"] >= 78:
        conf -= 15
        why += " | overbought"
    if side == "SELL" and m5["rsi"] <= 22:
        conf -= 15
        why += " | oversold"
    return {
        "symbol": symbol,
        "side": side,
        "conf": max(0, conf),
        "why": why or "no clear TF",
        "frames": frames,
        "tick": tick,
        "info": info,
        "enter_soft": conf >= 70 and side is not None,
        "enter_hard": conf >= 76 and side is not None,
    }


def news_bias_for(symbol: str, news: list[dict]) -> str:
    # Oddiy bias: yaqinda USD high → XAU/BTC risk-off / USD kuch ehtimoli (bearish risk assets / gold mixed)
    recent = [n for n in news if -180 <= n["minutesUntil"] <= 360]
    usd = [n for n in recent if n["currency"] == "USD" and n["impact"] == "high"]
    if "XAU" in symbol or "BTC" in symbol or "ETH" in symbol:
        if usd:
            titles = ", ".join(n["title"] for n in usd[:3])
            return (
                f"USD high-impact yaqin/o'tgan: {titles}. "
                "Ko'pincha dollar kuchi = XAU pastga bosim; BTC risk-offda pastga."
            )
    return "Maxsus USD high bias yo'q — texnik + AI asosiy."


def ask_openai(api_key: str, symbol: str, ta: dict, news: list[dict]) -> dict:
    bias = news_bias_for(symbol, news)
    payload = {
        "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        "temperature": 0.15,
        "max_tokens": 400,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "Sen professional treyder-analitiksan. Javob o'zbekcha JSON. "
                    "Texnik TF + dunyo yangiliklarini birga bahola. "
                    "PLUS-ONLY: minus xavfi bo'lsa allowEntry=false. "
                    "Faqat aniq prognoz va yangilik/trend mos bo'lsa allowEntry=true, confidence>=75. "
                    'JSON: {"forecast":"...","analysis":"...","side":"BUY|SELL|NONE","confidence":0-100,'
                    '"allowEntry":true|false,"reasons":["..."],"newsImpact":"bullish|bearish|neutral|volatile"}'
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "symbol": symbol,
                        "myTechnical": {
                            "side": ta["side"],
                            "confidence": ta["conf"],
                            "why": ta["why"],
                            "M5": ta["frames"]["M5"],
                            "M15": ta["frames"]["M15"],
                            "H1": ta["frames"]["H1"],
                            "price": ta["tick"].bid,
                        },
                        "worldNews": news,
                        "newsBiasHint": bias,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=40) as resp:
        body = json.loads(resp.read().decode())
    content = body["choices"][0]["message"]["content"]
    return json.loads(content)


def close_pos(p, why: str) -> bool:
    info = mt5.symbol_info(p.symbol)
    tick = mt5.symbol_info_tick(p.symbol)
    if not info or not tick:
        return False
    ct = mt5.ORDER_TYPE_SELL if int(p.type) == 0 else mt5.ORDER_TYPE_BUY
    price = tick.bid if int(p.type) == 0 else tick.ask
    r = mt5.order_send(
        {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "volume": float(p.volume),
            "type": ct,
            "position": int(p.ticket),
            "price": price,
            "deviation": 180,
            "magic": int(p.magic),
            "comment": why[:30],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling_of(info),
        }
    )
    ok = r is not None and int(r.retcode) == mt5.TRADE_RETCODE_DONE
    print("CLOSE", why, p.symbol, round(float(p.profit), 2), ok, flush=True)
    return ok


def open_trade(symbol: str, side: str, ta: dict, conf: int) -> bool:
    info = ta["info"]
    tick = mt5.symbol_info_tick(symbol)
    ai = mt5.account_info()
    px = tick.ask if side == "BUY" else tick.bid
    frac = 0.48 if conf >= 80 else 0.36
    maxv = (ai.margin_free * ai.leverage * frac) / (info.trade_contract_size * px)
    if "BTC" in symbol:
        cap = 0.4
    elif "ETH" in symbol:
        cap = 8.0
    else:
        cap = 0.1
    vol = max(
        float(info.volume_min),
        min(cap, math.floor(maxv / info.volume_step) * info.volume_step),
    )
    vol = float(f"{vol:.2f}")
    if vol < info.volume_min:
        print("NO_SIZE", symbol, flush=True)
        return False
    atr = ta["frames"]["M5"]["atr"]
    pv = info.trade_tick_value / info.trade_tick_size
    spread = abs(tick.ask - tick.bid)
    tp_money = max(10.0, min(28.0, ai.balance * 0.4))
    tp_dist = max(atr * 1.25, tp_money / (pv * vol), spread * 5)
    sl_dist = max(atr * 0.85, spread * 5)
    risk = (ai.balance * 0.22) / (pv * vol)
    sl_dist = min(max(sl_dist, spread * 3), max(risk, spread * 3))
    if "BTC" in symbol:
        sl_dist = max(sl_dist, 70)
        tp_dist = max(tp_dist, 100)
    if "ETH" in symbol:
        sl_dist = max(sl_dist, 2.5)
        tp_dist = max(tp_dist, 4.0)
    if "XAU" in symbol:
        sl_dist = max(sl_dist, 1.2)
        tp_dist = max(tp_dist, 2.5)

    otype = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if side == "BUY" else tick.bid
    r = mt5.order_send(
        {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": vol,
            "type": otype,
            "price": price,
            "sl": 0.0,
            "tp": 0.0,
            "deviation": 180,
            "magic": MAGIC,
            "comment": f"N{conf}",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling_of(info),
        }
    )
    if r is None or int(r.retcode) != mt5.TRADE_RETCODE_DONE:
        print("OPEN_FAIL", symbol, getattr(r, "retcode", None), getattr(r, "comment", None), flush=True)
        return False
    time.sleep(0.25)
    pos = None
    for p in mt5.positions_get(symbol=symbol) or []:
        if int(p.magic) == MAGIC:
            pos = p
            break
    if not pos:
        return False
    entry = float(pos.price_open)
    d = info.digits
    if int(pos.type) == 0:
        sl, tp = round(entry - sl_dist, d), round(entry + tp_dist, d)
    else:
        sl, tp = round(entry + sl_dist, d), round(entry - tp_dist, d)
    mt5.order_send(
        {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": symbol,
            "position": int(pos.ticket),
            "sl": sl,
            "tp": tp,
        }
    )
    print(
        "OPEN",
        symbol,
        side,
        "vol",
        vol,
        "conf",
        conf,
        "sl",
        sl,
        "tp",
        tp,
        flush=True,
    )
    return True


def main() -> None:
    key = load_openai_key()
    if not key:
        raise SystemExit("OPENAI_API_KEY topilmadi")

    if not mt5.initialize(PATH):
        raise SystemExit(mt5.last_error())
    if not mt5.login(LOGIN, password=PASSWORD, server=SERVER):
        raise SystemExit(mt5.last_error())

    news = fetch_calendar()
    print("NEWS", json.dumps(news[:8], ensure_ascii=False), flush=True)

    ai0 = mt5.account_info()
    start = float(ai0.balance)
    print("START", {"balance": start, "equity": ai0.equity}, flush=True)

    # Bank tiny leftover + if any
    for p in list(mt5.positions_get() or []):
        if float(p.profit) >= 0.25:
            close_pos(p, "bank+")

    decisions = []
    for symbol in SYMBOLS:
        ta = my_ta(symbol)
        if not ta:
            continue
        print(
            "TA",
            symbol,
            ta["side"],
            ta["conf"],
            ta["why"],
            "H1",
            ta["frames"]["H1"]["trend"],
            "M15",
            ta["frames"]["M15"]["trend"],
            "M5",
            ta["frames"]["M5"]["trend"],
            flush=True,
        )
        try:
            ai = ask_openai(key, symbol, ta, news)
        except Exception as e:
            print("AI_ERR", symbol, e, flush=True)
            continue
        ai_side = str(ai.get("side", "NONE")).upper()
        if ai_side in ("LONG",):
            ai_side = "BUY"
        if ai_side in ("SHORT",):
            ai_side = "SELL"
        conf = int(ai.get("confidence") or 0)
        allow = bool(ai.get("allowEntry")) and conf >= 75
        print(
            "AI",
            symbol,
            "side",
            ai_side,
            "conf",
            conf,
            "allow",
            allow,
            "news",
            ai.get("newsImpact"),
            flush=True,
        )
        print("  forecast:", (ai.get("forecast") or "")[:180], flush=True)
        print("  analysis:", (ai.get("analysis") or "")[:180], flush=True)

        # Dual: mening TA + AI bir xil, yoki AI kuchli + mening soft lean
        agree = False
        final = None
        if allow and ai_side in ("BUY", "SELL") and ta["side"] == ai_side and ta["conf"] >= 62:
            agree = True
            final = ai_side
        elif allow and ai_side in ("BUY", "SELL") and ta["enter_hard"] and ta["side"] == ai_side:
            agree = True
            final = ai_side
        # Yangilik bearish + AI SELL + H1/M15 down (M5 bounce ruxsat)
        news_bear = str(ai.get("newsImpact", "")).lower() in ("bearish", "volatile")
        if (
            not agree
            and allow
            and ai_side == "SELL"
            and ta["frames"]["H1"]["trend"] == "DOWN"
            and ta["frames"]["M15"]["trend"] == "DOWN"
            and conf >= 78
        ):
            agree = True
            final = "SELL"
        if (
            not agree
            and allow
            and ai_side == "BUY"
            and ta["frames"]["H1"]["trend"] == "UP"
            and ta["frames"]["M15"]["trend"] == "UP"
            and conf >= 78
        ):
            agree = True
            final = "BUY"

        print("  DECISION", "ENTER" if agree else "WAIT", final, "news_bear", news_bear, flush=True)
        if agree and final:
            decisions.append((conf, symbol, final, ta))

    decisions.sort(reverse=True)
    opened = 0
    have = {p.symbol for p in (mt5.positions_get() or [])}
    for conf, symbol, side, ta in decisions[:2]:
        if symbol in have:
            continue
        if open_trade(symbol, side, ta, conf):
            opened += 1
            have.add(symbol)

    if opened == 0:
        print("Aniq yangilik+prognoz mos kirish yo'q — noto'g'ri lot ochilmaydi", flush=True)

    # Manage up to 12 min: bank profits, cut only if AI/TF invalid
    deadline = time.time() + 12 * 60
    last_log = 0.0
    while time.time() < deadline:
        ai = mt5.account_info()
        made = float(ai.balance) - start
        if made >= TARGET_PROFIT and mt5.positions_total() == 0:
            break
        for p in list(mt5.positions_get() or []):
            pr = float(p.profit)
            if pr >= max(6.0, TARGET_PROFIT * 0.35) or pr >= 15:
                close_pos(p, "profit+")
                continue
            # equity path
            if start + made + pr >= start + TARGET_PROFIT and pr > 3:
                close_pos(p, "target")
        if time.time() - last_log > 20:
            ai = mt5.account_info()
            print(
                "status",
                {
                    "bal": round(ai.balance, 2),
                    "eq": round(ai.equity, 2),
                    "made": round(ai.balance - start, 2),
                    "pos": [
                        (p.symbol, "BUY" if p.type == 0 else "SELL", round(p.profit, 2))
                        for p in (mt5.positions_get() or [])
                    ],
                },
                flush=True,
            )
            last_log = time.time()
        time.sleep(0.8)

    for p in list(mt5.positions_get() or []):
        if float(p.profit) > 0:
            close_pos(p, "final+")

    ai = mt5.account_info()
    print(
        "FINAL",
        json.dumps(
            {
                "balance": round(ai.balance, 2),
                "equity": round(ai.equity, 2),
                "made": round(ai.balance - start, 2),
                "positions": [
                    {
                        "s": p.symbol,
                        "side": "BUY" if p.type == 0 else "SELL",
                        "pr": round(p.profit, 2),
                    }
                    for p in (mt5.positions_get() or [])
                ],
            }
        ),
        flush=True,
    )
    mt5.shutdown()


if __name__ == "__main__":
    main()
