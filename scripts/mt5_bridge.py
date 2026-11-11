#!/usr/bin/env python3
"""Exness MT5 bridge: account snapshot + market orders."""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


def find_terminal() -> str | None:
    configured = Path(os.environ.get("EXNESS_MT5_PATH", ""))
    candidates = [
        configured,
        Path(r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"),
        Path(r"C:\Program Files\Exness MT5\terminal64.exe"),
        Path(r"C:\Program Files\MetaTrader 5\terminal64.exe"),
    ]
    for path in candidates:
        if path and str(path) and path.exists():
            return str(path)
    return None


def period_pnl(mt5, date_from: datetime) -> float:
    deals = mt5.history_deals_get(date_from, datetime.now(timezone.utc))
    if deals is None:
        return 0.0
    last_balance_ts = None
    for deal in deals:
        if int(deal.type) == 2:
            ts = int(deal.time)
            if last_balance_ts is None or ts >= last_balance_ts:
                last_balance_ts = ts
    total = 0.0
    for deal in deals:
        if int(deal.type) not in (0, 1):
            continue
        if int(deal.entry) not in (1, 2, 3):
            continue
        if last_balance_ts is not None and int(deal.time) < last_balance_ts:
            continue
        total += float(deal.profit) + float(deal.swap) + float(deal.commission)
    return total


def resolve_symbol(mt5, requested: str) -> str | None:
    aliases = {
        "XAUUSD": ["XAUUSDm", "XAUUSD", "XAUUSD247m"],
        "BTCUSDT": ["BTCUSDm", "BTCUSD", "BTCUSDTm", "BTCUSDT"],
        "BTCUSD": ["BTCUSDm", "BTCUSD", "BTCUSDTm"],
        "ETHUSDT": ["ETHUSDm", "ETHUSD", "ETHUSDTm", "ETHUSDT"],
        "ETHUSD": ["ETHUSDm", "ETHUSD", "ETHUSDTm"],
    }
    candidates = aliases.get(requested.upper(), [requested])
    for name in candidates:
        info = mt5.symbol_info(name)
        if info is None:
            continue
        if not info.visible:
            mt5.symbol_select(name, True)
        return name
    return None


def round_volume(volume: float, step: float, vmin: float, vmax: float) -> float:
    if step <= 0:
        step = 0.01
    steps = math.floor(volume / step + 1e-12)
    out = max(vmin, min(vmax, steps * step))
    # keep 2 decimals typical for Exness micro
    return float(f"{out:.2f}")


def pick_filling(mt5, symbol_info) -> int:
    mode = int(symbol_info.filling_mode)
    # SYMBOL_FILLING_IOC=2, FOK=1, RETURN=4
    if mode & 2:
        return mt5.ORDER_FILLING_IOC
    if mode & 1:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


def place_order(mt5, raw: dict) -> dict:
    requested = str(raw.get("symbol", ""))
    side = str(raw.get("side", "LONG")).upper()
    volume = float(raw.get("volume", 0.01) or 0.01)
    sl = raw.get("stopLoss")
    tp = raw.get("takeProfit")
    comment = str(raw.get("comment", "Mizan agent"))[:30]

    symbol = resolve_symbol(mt5, requested)
    if not symbol:
        return {"ok": False, "error": f"Symbol topilmadi: {requested}"}

    info = mt5.symbol_info(symbol)
    if info is None:
        return {"ok": False, "error": f"symbol_info yo‘q: {symbol}"}
    if not info.visible:
        mt5.symbol_select(symbol, True)
        info = mt5.symbol_info(symbol)

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"ok": False, "error": f"tick yo‘q: {symbol}"}

    volume = round_volume(volume, info.volume_step, info.volume_min, info.volume_max)
    if volume < info.volume_min:
        return {"ok": False, "error": f"Hajm juda kichik: {volume} < {info.volume_min}"}

    order_type = mt5.ORDER_TYPE_BUY if side in ("LONG", "BUY") else mt5.ORDER_TYPE_SELL
    price = tick.ask if order_type == mt5.ORDER_TYPE_BUY else tick.bid
    point = info.point or 0.01
    digits = info.digits

    sl_price = float(sl) if sl is not None else 0.0
    tp_price = float(tp) if tp is not None else 0.0
    if sl_price:
        sl_price = round(sl_price, digits)
    if tp_price:
        tp_price = round(tp_price, digits)

    # Ensure SL/TP on correct side of price
    if order_type == mt5.ORDER_TYPE_BUY:
        if sl_price and sl_price >= price:
            sl_price = round(price - 50 * point, digits)
        if tp_price and tp_price <= price:
            tp_price = round(price + 100 * point, digits)
    else:
        if sl_price and sl_price <= price:
            sl_price = round(price + 50 * point, digits)
        if tp_price and tp_price >= price:
            tp_price = round(price - 100 * point, digits)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": sl_price,
        "tp": tp_price,
        "deviation": 80,
        "magic": 260311,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": pick_filling(mt5, info),
    }
    result = mt5.order_send(request)
    if result is None:
        return {"ok": False, "error": f"order_send None: {mt5.last_error()}", "request": request}

    ok = int(result.retcode) == mt5.TRADE_RETCODE_DONE
    return {
        "ok": ok,
        "retcode": int(result.retcode),
        "comment": result.comment,
        "order": int(result.order),
        "deal": int(result.deal),
        "volume": float(result.volume),
        "price": float(result.price),
        "symbol": symbol,
        "side": side,
        "sl": sl_price,
        "tp": tp_price,
        "request": request,
        "error": None if ok else f"retcode={result.retcode} {result.comment}",
    }


def positions_snapshot(mt5) -> list[dict]:
    rows = mt5.positions_get() or []
    out = []
    for pos in rows:
        out.append(
            {
                "ticket": int(pos.ticket),
                "symbol": pos.symbol,
                "type": "LONG" if int(pos.type) == 0 else "SHORT",
                "volume": float(pos.volume),
                "price_open": float(pos.price_open),
                "sl": float(pos.sl),
                "tp": float(pos.tp),
                "profit": float(pos.profit),
                "magic": int(pos.magic),
                "comment": pos.comment,
            }
        )
    return out


def close_position(mt5, raw: dict) -> dict:
    ticket = int(raw.get("ticket") or 0)
    requested = str(raw.get("symbol") or "")
    magic = int(raw.get("magic") or 260311)
    rows = list(mt5.positions_get() or [])
    target = None
    if ticket:
        for pos in rows:
            if int(pos.ticket) == ticket:
                target = pos
                break
    if target is None and requested:
        resolved = resolve_symbol(mt5, requested) or requested
        for pos in rows:
            if pos.symbol == resolved and (magic == 0 or int(pos.magic) == magic):
                target = pos
                break
    if target is None:
        return {"ok": False, "error": "Yopiladigan MT5 pozitsiya topilmadi"}

    tick = mt5.symbol_info_tick(target.symbol)
    info = mt5.symbol_info(target.symbol)
    if tick is None or info is None:
        return {"ok": False, "error": "Tick/symbol info yo‘q"}

    # position type 0=buy -> close with sell
    is_buy = int(target.type) == 0
    order_type = mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY
    price = tick.bid if is_buy else tick.ask
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": target.symbol,
        "volume": float(target.volume),
        "type": order_type,
        "position": int(target.ticket),
        "price": price,
        "deviation": 80,
        "magic": magic,
        "comment": "Mizan close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": pick_filling(mt5, info),
    }
    result = mt5.order_send(request)
    if result is None:
        return {"ok": False, "error": f"close None: {mt5.last_error()}", "request": request}
    ok = int(result.retcode) == mt5.TRADE_RETCODE_DONE
    return {
        "ok": ok,
        "retcode": int(result.retcode),
        "comment": result.comment,
        "order": int(result.order),
        "deal": int(result.deal),
        "price": float(result.price),
        "ticket": int(target.ticket),
        "symbol": target.symbol,
        "error": None if ok else f"retcode={result.retcode} {result.comment}",
    }


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    terminal = find_terminal()
    login = int(os.environ.get("EXNESS_MT5_LOGIN", "0") or "0")
    password = os.environ.get("EXNESS_MT5_PASSWORD", "")
    server = os.environ.get("EXNESS_MT5_SERVER", "")

    payload: dict = {
        "ok": False,
        "action": action,
        "terminal": terminal,
        "login": login or None,
        "server": server or None,
    }

    order_raw = None
    if action in ("order", "close"):
        if len(sys.argv) > 2:
            order_raw = json.loads(sys.argv[2])
        else:
            order_raw = json.loads(sys.stdin.read() or "{}")

    if not terminal:
        payload["error"] = "Exness MT5 terminal64.exe topilmadi"
        print(json.dumps(payload, ensure_ascii=False))
        return 2

    try:
        import MetaTrader5 as mt5  # type: ignore
    except Exception as exc:  # noqa: BLE001
        payload["error"] = f"MetaTrader5 paketi yo‘q: {exc}"
        print(json.dumps(payload, ensure_ascii=False))
        return 3

    init_kwargs = {"path": terminal, "timeout": 60_000}
    if login and password and server:
        init_kwargs.update(login=login, password=password, server=server)

    if not mt5.initialize(**init_kwargs):
        if not mt5.initialize(path=terminal, timeout=60_000):
            payload["error"] = f"initialize failed: {mt5.last_error()}"
            print(json.dumps(payload, ensure_ascii=False))
            return 4
        if login and password and server and not mt5.login(
            login, password=password, server=server
        ):
            payload["error"] = f"login failed: {mt5.last_error()}"
            mt5.shutdown()
            print(json.dumps(payload, ensure_ascii=False))
            return 5

    try:
        account = mt5.account_info()
        if account:
            now = datetime.now(timezone.utc)
            day_start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            week_start = day_start - timedelta(days=day_start.weekday())
            month_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
            floating = float(account.profit)
            payload["authorized"] = True
            payload["account"] = {
                "login": account.login,
                "name": account.name,
                "server": account.server,
                "company": account.company,
                "currency": account.currency,
                "balance": account.balance,
                "equity": account.equity,
                "margin": account.margin,
                "margin_free": account.margin_free,
                "profit": floating,
                "leverage": account.leverage,
                "trade_allowed": bool(account.trade_allowed),
                "trade_expert": bool(account.trade_expert),
                "trade_mode": account.trade_mode,
                "day_pnl": period_pnl(mt5, day_start) + floating,
                "week_pnl": period_pnl(mt5, week_start) + floating,
                "month_pnl": period_pnl(mt5, month_start) + floating,
            }

        if action == "symbols":
            symbols = {}
            for symbol in ["XAUUSDm", "BTCUSDm", "XAUUSD", "BTCUSD", "BTCUSDT"]:
                info = mt5.symbol_info_tick(symbol)
                if info:
                    symbols[symbol] = {
                        "bid": info.bid,
                        "ask": info.ask,
                        "time": info.time,
                    }
            payload["symbols"] = symbols

        if action == "positions":
            payload["positions"] = positions_snapshot(mt5)

        if action == "order" and order_raw is not None:
            order_result = place_order(mt5, order_raw)
            payload["order"] = order_result
            payload["positions"] = positions_snapshot(mt5)
            payload["ok"] = bool(order_result.get("ok"))
            if not payload["ok"]:
                payload["error"] = order_result.get("error")
            print(json.dumps(payload, ensure_ascii=False))
            return 0 if payload["ok"] else 6

        if action == "close" and order_raw is not None:
            close_result = close_position(mt5, order_raw)
            payload["close"] = close_result
            payload["positions"] = positions_snapshot(mt5)
            payload["ok"] = bool(close_result.get("ok"))
            if not payload["ok"]:
                payload["error"] = close_result.get("error")
            print(json.dumps(payload, ensure_ascii=False))
            return 0 if payload["ok"] else 7

        payload["ok"] = True
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
