#!/usr/bin/env python3
"""Multi-market analyzed entries — profit-focused, no spam scalping."""

from __future__ import annotations

import json
import math
import os
import time

import MetaTrader5 as mt5

PATH = os.environ.get("EXNESS_MT5_PATH", r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe")
LOGIN = int(os.environ.get("EXNESS_MT5_LOGIN", "0") or 0)
PASSWORD = os.environ.get("EXNESS_MT5_PASSWORD", "")
SERVER = os.environ.get("EXNESS_MT5_SERVER", "Exness-MT5Trial15")
MAGIC = 261211
TARGET = 65.0
SYMBOLS = [
    "ETHUSDm",
    "XAUUSDm",
    "BTCUSDm",
    "EURUSDm",
    "GBPUSDm",
    "USDJPYm",
    "XAGUSDm",
]
MAX_POS = 4
MAX_OPENS = 12


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


def analyze(symbol: str) -> dict | None:
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if not info or not tick or tick.bid <= 0:
        return None
    m5 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 80)
    m15 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M15, 0, 80)
    h1 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 80)
    if m5 is None or m15 is None or h1 is None:
        return None
    c5 = [float(x["close"]) for x in m5]
    c15 = [float(x["close"]) for x in m15]
    c1 = [float(x["close"]) for x in h1]
    e9_5, e21_5 = ema(c5[-30:], 9), ema(c5[-50:], 21)
    e9_15, e21_15 = ema(c15[-30:], 9), ema(c15[-50:], 21)
    e9_h, e21_h = ema(c1[-30:], 9), ema(c1[-50:], 21)
    atr = sum(float(m5[i]["high"]) - float(m5[i]["low"]) for i in range(-14, 0)) / 14
    rsi5, rsi15, rsih = rsi(c5), rsi(c15), rsi(c1)
    mom5 = c5[-1] - c5[-7]
    mom15 = c15[-1] - c15[-5]

    score = 0
    side = None
    reasons: list[str] = []

    align_up = e9_5 > e21_5 and e9_15 > e21_15 and e9_h > e21_h
    align_dn = e9_5 < e21_5 and e9_15 < e21_15 and e9_h < e21_h
    m_up = e9_5 > e21_5 and e9_15 > e21_15
    m_dn = e9_5 < e21_5 and e9_15 < e21_15

    if align_up:
        side = "BUY"
        score += 4
        reasons.append("M5+M15+H1 UP")
    elif align_dn:
        side = "SELL"
        score += 4
        reasons.append("M5+M15+H1 DOWN")
    elif m_up and mom5 > 0:
        side = "BUY"
        score += 3
        reasons.append("M5+M15 UP + mom")
    elif m_dn and mom5 < 0:
        side = "SELL"
        score += 3
        reasons.append("M5+M15 DOWN + mom")

    # H1 extreme mean-reversion only with M5 confirm
    if rsih <= 28 and e9_5 > e21_5 and mom5 > 0:
        if side is None or side == "BUY":
            side = "BUY"
            score += 3
            reasons.append(f"H1 RSI {rsih:.0f} bounce")
    if rsih >= 72 and e9_5 < e21_5 and mom5 < 0:
        if side is None or side == "SELL":
            side = "SELL"
            score += 3
            reasons.append(f"H1 RSI {rsih:.0f} fade")

    if side == "BUY" and mom15 > 0:
        score += 1
        reasons.append("M15 mom+")
    if side == "SELL" and mom15 < 0:
        score += 1
        reasons.append("M15 mom-")

    if side == "BUY" and rsi5 >= 78:
        score -= 3
        reasons.append("chase-overbought")
    if side == "SELL" and rsi5 <= 22:
        score -= 3
        reasons.append("chase-oversold")

    # fight H1 only if score still high from bounce logic
    if side == "BUY" and e9_h < e21_h and rsih > 40:
        score -= 1
    if side == "SELL" and e9_h > e21_h and rsih < 60:
        score -= 1

    spread = abs(float(tick.ask) - float(tick.bid))
    pv = float(info.trade_tick_value) / float(info.trade_tick_size) if info.trade_tick_size else 0.0
    if side is None or score < 3 or pv <= 0:
        return None
    return {
        "symbol": symbol,
        "side": side,
        "score": score,
        "reasons": reasons,
        "atr": atr,
        "spread": spread,
        "pv": pv,
        "info": info,
        "tick": tick,
        "rsi5": rsi5,
        "rsih": rsih,
    }


def close_pos(p, why: str) -> bool:
    info = mt5.symbol_info(p.symbol)
    tick = mt5.symbol_info_tick(p.symbol)
    if not info or not tick:
        return False
    close_type = mt5.ORDER_TYPE_SELL if int(p.type) == 0 else mt5.ORDER_TYPE_BUY
    price = tick.bid if int(p.type) == 0 else tick.ask
    r = mt5.order_send(
        {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "volume": float(p.volume),
            "type": close_type,
            "position": int(p.ticket),
            "price": price,
            "deviation": 160,
            "magic": MAGIC,
            "comment": why[:30],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling_of(info),
        }
    )
    ok = r is not None and int(r.retcode) == mt5.TRADE_RETCODE_DONE
    print(
        "CLOSE",
        why,
        p.symbol,
        "vol",
        p.volume,
        "pr",
        round(float(p.profit), 2),
        "ok",
        ok,
        flush=True,
    )
    return ok


def size_for(sig: dict, ai) -> float:
    info = sig["info"]
    tick = sig["tick"]
    side = sig["side"]
    px = float(tick.ask if side == "BUY" else tick.bid)
    # High conviction -> use more margin (not stuck on min lot)
    frac = 0.55 if sig["score"] >= 5 else 0.40 if sig["score"] >= 4 else 0.28
    # leave buffer for other markets
    open_n = len([p for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC])
    frac *= max(0.35, 1.0 - 0.15 * open_n)
    maxv = (float(ai.margin_free) * float(ai.leverage) * frac) / (
        float(info.trade_contract_size) * px
    )
    # soft caps so one symbol cannot nuke whole account instantly
    if "ETH" in sig["symbol"]:
        cap = 25.0
    elif "BTC" in sig["symbol"]:
        cap = 0.8
    elif "XAU" in sig["symbol"]:
        cap = 0.25
    elif "XAG" in sig["symbol"]:
        cap = 0.5
    else:
        cap = 2.0  # FX
    vol = max(
        float(info.volume_min),
        min(cap, float(info.volume_max), math.floor(maxv / info.volume_step) * info.volume_step),
    )
    return float(f"{vol:.2f}")


def open_setup(sig: dict, remain: float) -> bool:
    ai = mt5.account_info()
    info = sig["info"]
    tick = mt5.symbol_info_tick(sig["symbol"])
    if not tick:
        return False
    sig = {**sig, "tick": tick}
    vol = size_for(sig, ai)
    if vol < float(info.volume_min):
        print("NO_SIZE", sig["symbol"], "free", ai.margin_free, flush=True)
        return False
    pv = sig["pv"]
    # TP aimed at meaningful share of remain; SL by ATR
    tp_money = max(6.0, min(remain, remain * 0.55 if remain > 10 else remain))
    tp_dist = max(sig["atr"] * 1.1, tp_money / (pv * vol), sig["spread"] * 5)
    sl_dist = max(sig["atr"] * 0.85, sig["spread"] * 5)
    risk_cap = (float(ai.balance) * 0.28) / (pv * vol)
    sl_dist = min(max(sl_dist, sig["spread"] * 3), max(risk_cap, sig["spread"] * 3))
    # broker min distance
    if "ETH" in sig["symbol"]:
        sl_dist = max(sl_dist, 2.5)
        tp_dist = max(tp_dist, 3.0)
    elif "BTC" in sig["symbol"]:
        sl_dist = max(sl_dist, 40.0)
        tp_dist = max(tp_dist, 50.0)
    elif "XAU" in sig["symbol"]:
        sl_dist = max(sl_dist, 0.8)
        tp_dist = max(tp_dist, 1.2)

    side = sig["side"]
    otype = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
    price = float(tick.ask if side == "BUY" else tick.bid)
    r = mt5.order_send(
        {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": sig["symbol"],
            "volume": vol,
            "type": otype,
            "price": price,
            "sl": 0.0,
            "tp": 0.0,
            "deviation": 160,
            "magic": MAGIC,
            "comment": f"A{sig['score']}",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": filling_of(info),
        }
    )
    if r is None or int(r.retcode) != mt5.TRADE_RETCODE_DONE:
        print(
            "OPEN_FAIL",
            sig["symbol"],
            side,
            vol,
            getattr(r, "retcode", None),
            getattr(r, "comment", None),
            flush=True,
        )
        return False
    time.sleep(0.2)
    pos = None
    for p in mt5.positions_get(symbol=sig["symbol"]) or []:
        if int(p.magic) == MAGIC:
            pos = p
            break
    if pos is None:
        return False
    entry = float(pos.price_open)
    digits = info.digits
    if int(pos.type) == 0:
        sl, tp = round(entry - sl_dist, digits), round(entry + tp_dist, digits)
    else:
        sl, tp = round(entry + sl_dist, digits), round(entry - tp_dist, digits)
    mt5.order_send(
        {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": sig["symbol"],
            "position": int(pos.ticket),
            "sl": sl,
            "tp": tp,
        }
    )
    print(
        "OPEN",
        sig["symbol"],
        side,
        "vol",
        vol,
        "score",
        sig["score"],
        "sl",
        sl,
        "tp",
        tp,
        "|",
        "; ".join(sig["reasons"]),
        flush=True,
    )
    return True


def main() -> None:
    if not mt5.initialize(PATH):
        raise SystemExit(f"init fail {mt5.last_error()}")
    if not mt5.login(LOGIN, password=PASSWORD, server=SERVER):
        raise SystemExit(f"login fail {mt5.last_error()}")
    for s in SYMBOLS:
        mt5.symbol_select(s, True)

    ai = mt5.account_info()
    start_bal = float(ai.balance)
    print("START", {"balance": start_bal, "equity": float(ai.equity)}, flush=True)
    print("SCAN", flush=True)
    for s in SYMBOLS:
        sig = analyze(s)
        if sig:
            print(
                "  SIG",
                s,
                sig["side"],
                "score",
                sig["score"],
                "|",
                "; ".join(sig["reasons"]),
                flush=True,
            )
        else:
            print("  --", s, "no clear setup", flush=True)

    opens = 0
    deadline = time.time() + 18 * 60
    last_open = 0.0
    last_log = 0.0

    while time.time() < deadline:
        ai = mt5.account_info()
        made = float(ai.balance) - start_bal
        mine = [p for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC]
        float_pnl = sum(float(p.profit) for p in mine)

        # Hit target: bank all +
        if made >= TARGET and not mine:
            print("HIT", ai.balance, flush=True)
            break
        if start_bal + made + float_pnl >= start_bal + TARGET:
            for p in list(mine):
                if float(p.profit) > 0:
                    close_pos(p, "target65")
            time.sleep(0.25)
            if float(mt5.account_info().balance) - start_bal >= TARGET:
                for p in list(mt5.positions_get() or []):
                    if int(p.magic) == MAGIC and float(p.profit) >= 0:
                        close_pos(p, "target65")
                if not [p for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC]:
                    print("HIT", mt5.account_info().balance, flush=True)
                    break

        # Manage: ONLY take profit when green; cut only clear structure failure
        for p in list(mt5.positions_get() or []):
            if int(p.magic) != MAGIC:
                continue
            pr = float(p.profit)
            remain = TARGET - (float(mt5.account_info().balance) - start_bal)
            if pr >= max(4.0, min(25.0, remain * 0.85)) or pr >= 20:
                close_pos(p, "profit+")
                continue
            if pr > 1.5:
                # lock small profits rather than give back to zero
                sig = analyze(p.symbol)
                if sig and (
                    (int(p.type) == 0 and sig["side"] == "SELL" and sig["score"] >= 3)
                    or (int(p.type) == 1 and sig["side"] == "BUY" and sig["score"] >= 3)
                ):
                    close_pos(p, "lock+")
                    continue
            if pr < 0:
                sig = analyze(p.symbol)
                against = sig and (
                    (int(p.type) == 0 and sig["side"] == "SELL" and sig["score"] >= 4)
                    or (int(p.type) == 1 and sig["side"] == "BUY" and sig["score"] >= 4)
                )
                if against and pr <= -max(1.2, start_bal * 0.18):
                    close_pos(p, "invalid")
                    continue

        ai = mt5.account_info()
        made = float(ai.balance) - start_bal
        mine = [p for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC]

        # Open best clear markets (multi), sized by conviction — not min-lot stuck
        if len(mine) < MAX_POS and opens < MAX_OPENS and time.time() - last_open > 6:
            have = {p.symbol for p in mine}
            cands = []
            for s in SYMBOLS:
                if s in have:
                    continue
                sig = analyze(s)
                if sig and sig["score"] >= 3:
                    cands.append(sig)
            cands.sort(key=lambda x: x["score"], reverse=True)
            opened_now = 0
            for sig in cands[:2]:
                if len([p for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC]) >= MAX_POS:
                    break
                remain = TARGET - (float(mt5.account_info().balance) - start_bal)
                if remain <= 0:
                    break
                if open_setup(sig, remain):
                    opens += 1
                    opened_now += 1
                    last_open = time.time()
                if opened_now >= 2:
                    break

        if time.time() - last_log > 12:
            ai = mt5.account_info()
            poss = [
                {"s": p.symbol, "v": p.volume, "pr": round(float(p.profit), 2)}
                for p in (mt5.positions_get() or [])
                if int(p.magic) == MAGIC
            ]
            print(
                "status",
                {
                    "bal": round(ai.balance, 2),
                    "eq": round(ai.equity, 2),
                    "made": round(ai.balance - start_bal, 2),
                    "pos": poss,
                    "opens": opens,
                },
                flush=True,
            )
            last_log = time.time()
        time.sleep(0.6)

    # Final bank profits
    for p in list(mt5.positions_get() or []):
        if int(p.magic) == MAGIC and float(p.profit) > 0:
            close_pos(p, "final+")
    time.sleep(0.3)
    # if target not reached, keep winners a bit more
    t2 = time.time() + 45
    while time.time() < t2:
        ai = mt5.account_info()
        if float(ai.balance) - start_bal >= TARGET:
            break
        for p in list(mt5.positions_get() or []):
            if int(p.magic) == MAGIC and float(p.profit) >= 2:
                close_pos(p, "late+")
        time.sleep(1)

    for p in list(mt5.positions_get() or []):
        if int(p.magic) == MAGIC:
            close_pos(p, "flatten")

    ai = mt5.account_info()
    print(
        "FINAL",
        json.dumps(
            {
                "balance": round(ai.balance, 2),
                "equity": round(ai.equity, 2),
                "made": round(ai.balance - start_bal, 2),
                "positions": mt5.positions_total(),
                "opens": opens,
            }
        ),
        flush=True,
    )
    mt5.shutdown()


if __name__ == "__main__":
    main()
