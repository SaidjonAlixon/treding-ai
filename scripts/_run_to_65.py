import json
import math
import os
import time

import MetaTrader5 as mt5

PATH = os.environ.get("EXNESS_MT5_PATH", r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe")
LOGIN = int(os.environ.get("EXNESS_MT5_LOGIN", "0") or 0)
PASSWORD = os.environ.get("EXNESS_MT5_PASSWORD", "")
SERVER = os.environ.get("EXNESS_MT5_SERVER", "Exness-MT5Trial15")
MAGIC = 261165
TARGET = 65.0
SYMBOLS = ["ETHUSDm", "XAUUSDm", "BTCUSDm"]
MAX_POS = 3
MAX_ATTEMPTS = 8

mt5.initialize(PATH)
assert mt5.login(LOGIN, password=PASSWORD, server=SERVER)
for s in SYMBOLS:
    mt5.symbol_select(s, True)

def filling_of(info):
    m = int(info.filling_mode)
    if m & 2: return mt5.ORDER_FILLING_IOC
    if m & 1: return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN

def ema(vals, n):
    k = 2 / (n + 1)
    e = vals[0]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
    return e

def rsi(closes, n=14):
    ch = [closes[i] - closes[i - 1] for i in range(-n, 0)]
    up = sum(x for x in ch if x > 0) / n
    dn = abs(sum(x for x in ch if x < 0)) / n
    if dn == 0:
        return 100.0
    return 100 - 100 / (1 + up / dn)

def analyze(symbol):
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if not info or not tick:
        return None
    m5 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M5, 0, 60)
    m15 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M15, 0, 60)
    h1 = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_H1, 0, 60)
    if m5 is None or m15 is None or h1 is None:
        return None
    c5 = [float(x["close"]) for x in m5]
    c15 = [float(x["close"]) for x in m15]
    c1 = [float(x["close"]) for x in h1]
    e9_5, e21_5 = ema(c5[-25:], 9), ema(c5[-40:], 21)
    e9_15, e21_15 = ema(c15[-25:], 9), ema(c15[-40:], 21)
    e9_h, e21_h = ema(c1[-25:], 9), ema(c1[-40:], 21)
    atr5 = sum(float(m5[i]["high"]) - float(m5[i]["low"]) for i in range(-14, 0)) / 14
    rsi5, rsi15, rsih = rsi(c5), rsi(c15), rsi(c1)
    score = 0
    side = None
    reasons = []

    # H1 oversold bounce (mean reversion) — strong only with M5 confirmation
    if rsih <= 30 and e9_5 > e21_5 and c5[-1] > c5[-4]:
        side = "BUY"
        score += 3
        reasons.append(f"H1 RSI oversold {rsih:.0f} + M5 turn UP")
        if rsi15 < 40:
            score += 1
            reasons.append("M15 still soft -> bounce room")
    # H1 overbought fade
    elif rsih >= 70 and e9_5 < e21_5 and c5[-1] < c5[-4]:
        side = "SELL"
        score += 3
        reasons.append(f"H1 RSI overbought {rsih:.0f} + M5 turn DOWN")

    # Trend follow when M5+M15+H1 align
    up = e9_5 > e21_5 and e9_15 > e21_15 and e9_h > e21_h
    dn = e9_5 < e21_5 and e9_15 < e21_15 and e9_h < e21_h
    if up:
        if side is None:
            side = "BUY"
        if side == "BUY":
            score += 3
            reasons.append("M5+M15+H1 UP align")
    if dn:
        if side is None:
            side = "SELL"
        if side == "SELL":
            score += 3
            reasons.append("M5+M15+H1 DOWN align")

    # M5+M15 align only (medium)
    if side is None:
        if e9_5 > e21_5 and e9_15 > e21_15 and rsi5 < 70:
            side = "BUY"
            score += 2
            reasons.append("M5+M15 UP")
        elif e9_5 < e21_5 and e9_15 < e21_15 and rsi5 > 30:
            side = "SELL"
            score += 2
            reasons.append("M5+M15 DOWN")

    # momentum confirm last 3 M5
    if side == "BUY" and c5[-1] > c5[-4]:
        score += 1
        reasons.append("M5 momentum+")
    if side == "SELL" and c5[-1] < c5[-4]:
        score += 1
        reasons.append("M5 momentum-")

    # reject weak / overextended chase
    if side == "BUY" and rsi5 >= 78:
        score -= 2
        reasons.append("M5 RSI too high")
    if side == "SELL" and rsi5 <= 22:
        score -= 2
        reasons.append("M5 RSI too low")

    spread = abs(tick.ask - tick.bid)
    pv = info.trade_tick_value / info.trade_tick_size if info.trade_tick_size else 0
    if score < 3 or side is None or pv <= 0:
        return None
    return {
        "symbol": symbol,
        "side": side,
        "score": score,
        "reasons": reasons,
        "atr": atr5,
        "spread": spread,
        "pv": pv,
        "info": info,
        "tick": tick,
    }

def close_pos(p, why):
    info = mt5.symbol_info(p.symbol)
    tick = mt5.symbol_info_tick(p.symbol)
    if not info or not tick:
        return False
    close_type = mt5.ORDER_TYPE_SELL if int(p.type) == 0 else mt5.ORDER_TYPE_BUY
    price = tick.bid if int(p.type) == 0 else tick.ask
    r = mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": p.symbol,
        "volume": float(p.volume),
        "type": close_type,
        "position": int(p.ticket),
        "price": price,
        "deviation": 120,
        "magic": MAGIC,
        "comment": why[:30],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_of(info),
    })
    ok = r is not None and int(r.retcode) == mt5.TRADE_RETCODE_DONE
    print("CLOSE", p.symbol, int(p.ticket), "pr", round(float(p.profit), 2), why, "ok", ok, flush=True)
    return ok

def open_setup(sig, start_bal, made_need):
    ai = mt5.account_info()
    info = sig["info"]
    tick = sig["tick"]
    side = sig["side"]
    px = tick.ask if side == "BUY" else tick.bid
    # size: leave room for up to MAX_POS
    free_frac = 0.28
    maxv = (ai.margin_free * ai.leverage * free_frac) / (info.trade_contract_size * px)
    cap = 5.0 if "ETH" in sig["symbol"] else (0.06 if "XAU" in sig["symbol"] else 0.2)
    vol = max(info.volume_min, min(cap, math.floor(maxv / info.volume_step) * info.volume_step))
    vol = float(f"{vol:.2f}")
    if vol < info.volume_min:
        return False
    # per-trade target share of remaining
    remain = max(8.0, made_need)
    per = remain / max(1, MAX_POS - mt5.positions_total())
    tp_dist = max(sig["atr"] * 1.2, per / (sig["pv"] * vol), sig["spread"] * 4)
    sl_dist = max(sig["atr"] * 0.9, sig["spread"] * 4, 2.5 if "ETH" in sig["symbol"] else (0.8 if "XAU" in sig["symbol"] else 40))
    # risk cap ~25% balance on this trade
    risk_dist = (ai.balance * 0.25) / (sig["pv"] * vol)
    sl_dist = min(sl_dist, max(risk_dist, sig["spread"] * 3))
    if tp_dist / max(sl_dist, 1e-9) < 1.2:
        # skip poor RR
        print("SKIP_RR", sig["symbol"], "tp", round(tp_dist, 3), "sl", round(sl_dist, 3), flush=True)
        return False

    otype = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if side == "BUY" else tick.bid
    r = mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": sig["symbol"],
        "volume": vol,
        "type": otype,
        "price": price,
        "sl": 0.0,
        "tp": 0.0,
        "deviation": 120,
        "magic": MAGIC,
        "comment": f"an{sig['score']}",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_of(info),
    })
    if r is None or int(r.retcode) != mt5.TRADE_RETCODE_DONE:
        print("OPEN_FAIL", sig["symbol"], getattr(r, "retcode", None), getattr(r, "comment", None), flush=True)
        return False
    time.sleep(0.25)
    pos = None
    for p in mt5.positions_get(symbol=sig["symbol"]) or []:
        if int(p.magic) == MAGIC and abs(float(p.volume) - vol) < 1e-6:
            pos = p
            break
    if pos is None:
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
    mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "symbol": sig["symbol"], "position": int(pos.ticket), "sl": sl, "tp": tp})
    print(
        "OPEN",
        sig["symbol"],
        side,
        vol,
        "score",
        sig["score"],
        "entry",
        entry,
        "sl",
        sl,
        "tp",
        tp,
        "|",
        "; ".join(sig["reasons"]),
        flush=True,
    )
    return True

ai = mt5.account_info()
start_bal = float(ai.balance)
print("START", {"balance": start_bal, "equity": ai.equity}, flush=True)
# flatten foreign leftovers? only close ours if any
attempts = 0
deadline = time.time() + 20 * 60
last_open = 0
last_log = 0

while time.time() < deadline:
    ai = mt5.account_info()
    made = float(ai.balance) - start_bal
    float_pnl = sum(float(p.profit) for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC)
    if made >= TARGET and mt5.positions_total() == 0:
        print("HIT_BAL", ai.balance, flush=True)
        break
    # bank if equity path hits and positions in profit overall
    if start_bal + made + max(float_pnl, 0) >= start_bal + TARGET and float_pnl > 0:
        # close profitable ones first
        for p in list(mt5.positions_get() or []):
            if int(p.magic) == MAGIC and float(p.profit) > 0:
                close_pos(p, "target65")
        time.sleep(0.2)
        ai = mt5.account_info()
        if float(ai.balance) - start_bal >= TARGET and all(
            int(p.magic) != MAGIC for p in (mt5.positions_get() or [])
        ):
            print("HIT", ai.balance, flush=True)
            break

    # manage open: take solid partial profits, cut structure breaks
    for p in list(mt5.positions_get() or []):
        if int(p.magic) != MAGIC:
            continue
        pr = float(p.profit)
        # take profit early if single trade already covers remaining
        remain = TARGET - (float(mt5.account_info().balance) - start_bal)
        if pr >= max(8.0, remain * 0.9) or pr >= 25:
            close_pos(p, "bank+")
            continue
        # structure flip exit if small loss or tiny profit
        sig = analyze(p.symbol)
        if sig:
            bad = (int(p.type) == 0 and sig["side"] == "SELL" and sig["score"] >= 3) or (
                int(p.type) == 1 and sig["side"] == "BUY" and sig["score"] >= 3
            )
            if bad and pr < 5:
                close_pos(p, "structure")
                continue
        if pr <= - (start_bal * 0.22):
            close_pos(p, "riskcut")

    ai = mt5.account_info()
    made = float(ai.balance) - start_bal
    if made >= TARGET:
        for p in list(mt5.positions_get() or []):
            if int(p.magic) == MAGIC and float(p.profit) >= 0:
                close_pos(p, "done+")
        if all(int(p.magic) != MAGIC for p in (mt5.positions_get() or [])):
            break

    # open new only on high score, cooldown 8s, not spam
    mine = [p for p in (mt5.positions_get() or []) if int(p.magic) == MAGIC]
    if len(mine) < MAX_POS and attempts < MAX_ATTEMPTS and time.time() - last_open > 8:
        cands = []
        have = {p.symbol for p in mine}
        for s in SYMBOLS:
            if s in have:
                continue
            sig = analyze(s)
            if sig and sig["score"] >= 3:
                cands.append(sig)
        cands.sort(key=lambda x: x["score"], reverse=True)
        if cands:
            remain = TARGET - made
            if open_setup(cands[0], start_bal, remain):
                attempts += 1
                last_open = time.time()

    if time.time() - last_log > 15:
        ai = mt5.account_info()
        poss = [
            {"s": p.symbol, "v": p.volume, "pr": round(float(p.profit), 2)}
            for p in (mt5.positions_get() or [])
            if int(p.magic) == MAGIC
        ]
        print(
            "status",
            {"bal": round(ai.balance, 2), "eq": round(ai.equity, 2), "made": round(ai.balance - start_bal, 2), "pos": poss, "attempts": attempts},
            flush=True,
        )
        last_log = time.time()
    time.sleep(0.7)

# final: bank any +
for p in list(mt5.positions_get() or []):
    if int(p.magic) == MAGIC and float(p.profit) > 0:
        close_pos(p, "final+")
time.sleep(0.3)
# if still short of target but have open losers, leave? User wants result - close all ours to free
ai = mt5.account_info()
if float(ai.balance) - start_bal < TARGET:
    # brief wait for float
    t2 = time.time() + 30
    while time.time() < t2:
        for p in list(mt5.positions_get() or []):
            if int(p.magic) == MAGIC and float(p.profit) >= 3:
                close_pos(p, "late+")
        if float(mt5.account_info().balance) - start_bal >= TARGET:
            break
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
            "attempts": attempts,
        }
    ),
    flush=True,
)
mt5.shutdown()
