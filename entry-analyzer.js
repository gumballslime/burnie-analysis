/**
 * entry-analyzer.js
 *
 * For each confirmed $BURNIE cabal wallet, fetches:
 *   - Entry time (first buy timestamp)
 *   - All buy/sell transactions since token launch
 *   - Average cost basis (SOL per token + USD)
 *   - Current holdings (live on-chain)
 *   - Unrealized P&L (SOL + USD)
 *
 * Usage: node entry-analyzer.js
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const MINT       = "CGEDT9QZDvvH5GmVkWJH2BXiMJqMJySC9ihWyr7Spump";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DECIMALS   = 6;
const LAMPORTS   = 1_000_000_000;
const SUPPLY     = 979_997_784.433; // from snapshot
// Token launched April 3 2026 — only look at txs from this point forward
const LAUNCH_EPOCH = 1743638400; // 2026-04-03 00:00:00 UTC

// ── API key ───────────────────────────────────────────────────────────────────

let HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY) {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    HELIUS_API_KEY = JSON.parse(readFileSync(join(__dir, "apikey.json"), "utf8")).apiKey;
  } catch {}
}
if (!HELIUS_API_KEY) { console.error("❌ No Helius API key"); process.exit(1); }
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// ── Confirmed cabal wallets ───────────────────────────────────────────────────

const CABAL = [
  // Group 1 — parent: 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9 (2.34M SOL — likely exchange)
  { group: 1, wallet: "58gqgnsK7sEpxTpJxb6s4xie7i8STH6k9SggJZ7mzoHH" },
  { group: 1, wallet: "A1w4HSb7XHhdsr4F8kDT3quVEGEp8pL8jLr9QRBxJB9S" },
  { group: 1, wallet: "7x7pZXGeB6349fVM2GPzDZMBtFZqC7aA5b68nPqSdvpE" },
  { group: 1, wallet: "GaPCg8J5DEEAyeyMnVWpyAWWGqx5AzcZeJgipWwnfsWZ" },
  { group: 1, wallet: "8BzHUpmUfXy9jv75d9BdQhggrtnkaMnEs8CxPFH2tsEe" },
  { group: 1, wallet: "12KL55DxHz2kvZM7hVbD7Rviv92EiyH9m5oHGubYHePs" },
  { group: 1, wallet: "5Q3eeysqNfjgtCQxUhyswxqS8Dcr8MzrSJ3FhmTnnU6C" },
  { group: 1, wallet: "EAWrgX8oyEQWkWqRR69iPoQ8W4scBoh9UCiprTXx6kwf" },
  // Group 2 — parent: 4AV2Qzp3N4c9RfzyEbNZs2wqWfW4EwKnnxFAZCndvfGh (Privacy-Cash ZK mixer)
  { group: 2, wallet: "BC2QqtTbM8mPZbntXasByYMqhd2ZWrytVQC4AxsbVwZH" },
  { group: 2, wallet: "BeQSxC4myeaLAURRdicnJrMC9U2RUVGq74hmQkPf49Zr" },
  // Group 3 — parent: 6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF (977k SOL — likely exchange)
  { group: 3, wallet: "5YKMkGrZbTawQE99tfEbeE62B9C4KdDy1MCSBN8ukKxh" },
  { group: 3, wallet: "2vQNZx2ETSwqc4HxtrJ4oCa1QgKbBsqUrwfeCqcFyYFx" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep     = ms => new Promise(r => setTimeout(r, ms));
const shortAddr = a  => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmtN      = (n, d = 4) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 2 });
const fmtTok    = n  => Math.round(n).toLocaleString();
const fmtUsd    = n  => "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

async function rpcCall(method, params) {
  const resp = await fetch(RPC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

// ── Live holdings ─────────────────────────────────────────────────────────────

async function getCurrentHoldings(wallet) {
  try {
    const accounts = await rpcCall("getProgramAccounts", [
      TOKEN_2022,
      {
        encoding: "jsonParsed",
        filters: [
          { memcmp: { offset: 0,  bytes: MINT   } },
          { memcmp: { offset: 32, bytes: wallet } },
        ],
      },
    ]);
    let total = 0n;
    for (const acct of accounts ?? []) {
      const amt = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amt) total += BigInt(amt);
    }
    return Number(total) / Math.pow(10, DECIMALS);
  } catch {
    return 0;
  }
}

// ── Transaction signatures (post-launch only) ─────────────────────────────────

async function getSignatures(wallet) {
  const allSigs = [];
  let before = undefined;

  for (let page = 0; page < 5; page++) {
    const params = [wallet, { limit: 1000, ...(before ? { before } : {}) }];
    const sigs   = await rpcCall("getSignaturesForAddress", params);
    if (!sigs || sigs.length === 0) break;

    for (const s of sigs) {
      if (s.blockTime && s.blockTime < LAUNCH_EPOCH) {
        return allSigs; // passed back before launch, stop
      }
      if (!s.err) allSigs.push(s); // skip failed txs
    }

    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await sleep(100);
  }

  return allSigs;
}

// ── Parse a single transaction for BURNIE trades ──────────────────────────────

function parseTrade(tx, wallet) {
  if (!tx?.meta) return null;
  const meta = tx.meta;

  // Token balance change for this wallet + this mint
  const preEntry  = meta.preTokenBalances?.find(b => b.owner === wallet && b.mint === MINT);
  const postEntry = meta.postTokenBalances?.find(b => b.owner === wallet && b.mint === MINT);

  const preAmt  = preEntry  ? Number(BigInt(preEntry.uiTokenAmount.amount))  : 0;
  const postAmt = postEntry ? Number(BigInt(postEntry.uiTokenAmount.amount)) : 0;
  const rawDelta = postAmt - preAmt;
  const tokenDelta = rawDelta / Math.pow(10, DECIMALS);

  if (Math.abs(tokenDelta) < 1) return null; // no meaningful change

  // SOL change for the wallet (pre - post = SOL that left wallet, positive = spent)
  const keys     = tx.transaction.message.accountKeys;
  const accounts = keys.map(k => (typeof k === "string" ? k : k.pubkey));
  const widx     = accounts.indexOf(wallet);
  let solDelta   = 0;
  if (widx >= 0) {
    solDelta = ((meta.preBalances[widx] ?? 0) - (meta.postBalances[widx] ?? 0)) / LAMPORTS;
    if (widx === 0) solDelta -= (meta.fee ?? 0) / LAMPORTS; // subtract tx fee for fee payer
  }

  const isBuy  = tokenDelta >  1  && solDelta >  0.0005; // received tokens, paid SOL
  const isSell = tokenDelta < -1  && solDelta < -0.0005; // sent tokens, received SOL

  if (!isBuy && !isSell) return null;

  return {
    signature:  tx.transaction.signatures?.[0] ?? "",
    blockTime:  tx.blockTime ?? 0,
    tokenDelta,
    solDelta,   // positive = SOL left wallet (buy), negative = SOL entered wallet (sell)
    isBuy,
    isSell,
  };
}

// ── Batch fetch and parse transactions ────────────────────────────────────────

async function fetchTrades(wallet, sigs) {
  const trades = [];
  const BATCH  = 5;

  for (let i = 0; i < sigs.length; i += BATCH) {
    const batch = sigs.slice(i, i + BATCH);
    const txs   = await Promise.all(
      batch.map(s =>
        rpcCall("getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]).catch(() => null)
      )
    );
    for (const tx of txs) {
      const trade = parseTrade(tx, wallet);
      if (trade) trades.push(trade);
    }
    await sleep(200);
  }

  return trades;
}

// ── DexScreener price ─────────────────────────────────────────────────────────

async function fetchPrice() {
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT}`);
    const data = await resp.json();
    const pair = data.pairs?.[0];
    if (!pair) throw new Error("no pair");
    const priceUsd = parseFloat(pair.priceUsd   ?? 0);
    const priceSol = parseFloat(pair.priceNative ?? 0);
    const solUsd   = priceSol > 0 ? priceUsd / priceSol : 200;
    const mcap     = parseFloat(pair.fdv ?? pair.marketCap ?? 0);
    return { priceUsd, priceSol, solUsd, mcap };
  } catch {
    return { priceUsd: 0, priceSol: 0, solUsd: 200, mcap: 0 };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const LINE = "═".repeat(100);
  const line = "─".repeat(100);

  console.log(`\n🔍 $BURNIE — Cabal Entry & P&L Analysis\n`);

  process.stdout.write("Fetching current price from DexScreener...");
  const price = await fetchPrice();
  console.log(` ${price.priceUsd.toExponential(3)} USD | SOL ≈ $${price.solUsd.toFixed(0)} | MCAP $${(price.mcap / 1e6).toFixed(2)}M`);

  const results = [];

  for (let i = 0; i < CABAL.length; i++) {
    const { group, wallet } = CABAL[i];
    process.stdout.write(`\n[${i + 1}/${CABAL.length}] G${group} ${shortAddr(wallet)}`);

    // Live holdings
    process.stdout.write(" → holdings...");
    const currentHoldings = await getCurrentHoldings(wallet);
    await sleep(200);

    // Signatures since launch
    process.stdout.write(" sigs...");
    const sigs = await getSignatures(wallet);
    process.stdout.write(` (${sigs.length})`);

    // Parse trades
    process.stdout.write(" → trades...");
    const trades = await fetchTrades(wallet, sigs);
    const buys   = trades.filter(t => t.isBuy).sort((a, b) => a.blockTime - b.blockTime);
    const sells  = trades.filter(t => t.isSell);

    const totalSolSpent     = buys.reduce((s, t) => s + t.solDelta, 0);
    const totalTokensBought = buys.reduce((s, t) => s + t.tokenDelta, 0);
    const avgCostSol        = totalTokensBought > 0 ? totalSolSpent / totalTokensBought : 0;
    const avgCostUsd        = avgCostSol * price.solUsd;

    const firstBuy          = buys[0] ?? null;

    const currentValueSol   = currentHoldings * price.priceSol;
    const currentValueUsd   = currentHoldings * price.priceUsd;
    const upnlSol           = currentValueSol - totalSolSpent;
    const upnlUsd           = upnlSol * price.solUsd;
    const upnlPct           = totalSolSpent > 0 ? (upnlSol / totalSolSpent) * 100 : 0;
    const multiple          = totalSolSpent > 0 && currentValueSol > 0
      ? currentValueSol / totalSolSpent
      : 0;

    results.push({
      group, wallet,
      firstBuy,
      buys:            buys.length,
      sells:           sells.length,
      totalSolSpent,
      totalTokensBought,
      avgCostSol,
      avgCostUsd,
      currentHoldings,
      currentValueSol,
      currentValueUsd,
      upnlSol,
      upnlUsd,
      upnlPct,
      multiple,
    });

    const entryStr = firstBuy
      ? new Date(firstBuy.blockTime * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z"
      : "no buys found";
    const pnlStr = `${upnlSol >= 0 ? "+" : ""}${fmtN(upnlSol, 2)} SOL (${upnlSol >= 0 ? "+" : ""}${upnlPct.toFixed(0)}%)`;
    console.log(` | entry: ${entryStr} | hold: ${fmtTok(currentHoldings)} | uPnL: ${pnlStr}`);

    await sleep(300);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  console.log(`\n\n${LINE}`);
  console.log(`  $BURNIE (Burnie Senders) — CABAL ENTRY & P&L REPORT`);
  console.log(`  Snapshot: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
  console.log(`  Price: ${price.priceUsd.toExponential(3)} USD  |  ${price.priceSol.toExponential(3)} SOL  |  SOL ≈ $${price.solUsd.toFixed(0)}  |  MCAP $${(price.mcap / 1e6).toFixed(2)}M`);
  console.log(`${LINE}\n`);

  const parentInfo = {
    1: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9  [2,339,844 SOL — likely exchange]",
    2: "4AV2Qzp3N4c9RfzyEbNZs2wqWfW4EwKnnxFAZCndvfGh  [Privacy-Cash ZK mixer]",
    3: "6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF  [977,729 SOL — likely exchange]",
  };

  for (const g of [1, 2, 3]) {
    const group = results.filter(r => r.group === g);
    if (!group.length) continue;

    console.log(`GROUP ${g}  ──  Parent: ${parentInfo[g]}`);
    console.log(line);

    for (const r of group) {
      const entryStr = r.firstBuy
        ? new Date(r.firstBuy.blockTime * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
        : "no buys detected";
      const pnlSign = r.upnlSol >= 0 ? "+" : "-";
      const pnlIcon = r.upnlSol >= 0 ? "▲ PROFIT" : "▼ LOSS  ";
      const pctHeld = (r.currentHoldings / SUPPLY * 100).toFixed(3);
      const pctBought = r.totalTokensBought > 0
        ? (r.totalTokensBought / SUPPLY * 100).toFixed(3)
        : "0.000";

      console.log(`\n  ${shortAddr(r.wallet)}`);
      console.log(`  ${r.wallet}`);
      console.log(`  https://orbmarkets.io/address/${r.wallet}`);
      console.log(`  ${"─".repeat(96)}`);
      console.log(`  Entry Time   ${entryStr}`);
      console.log(`  Buys / Sells ${r.buys} buys  /  ${r.sells} sells`);
      console.log(`  SOL Invested ${fmtN(r.totalSolSpent, 3)} SOL         (~${fmtUsd(r.totalSolSpent * price.solUsd)})`);
      console.log(`  Tokens Bought ${fmtTok(r.totalTokensBought)} tokens   (${pctBought}% supply)`);
      console.log(`  Avg Cost     ${r.avgCostSol.toExponential(4)} SOL/token  (~${r.avgCostUsd.toExponential(4)} USD/token)`);
      console.log(`  ──`);
      console.log(`  Holding Now  ${fmtTok(r.currentHoldings)} tokens   (${pctHeld}% supply)`);
      console.log(`  Value Now    ${fmtN(r.currentValueSol, 4)} SOL       (~${fmtUsd(r.currentValueUsd)})`);
      console.log(`  Multiple     ${r.multiple > 0 ? r.multiple.toFixed(2) + "x" : "n/a"}`);
      console.log(`  uPnL         ${pnlIcon}   ${pnlSign}${fmtN(Math.abs(r.upnlSol), 3)} SOL  (~${pnlSign}${fmtUsd(Math.abs(r.upnlUsd))})  ${pnlSign}${r.upnlPct.toFixed(1)}%`);
    }

    const gSolIn    = group.reduce((s, r) => s + r.totalSolSpent,   0);
    const gHolding  = group.reduce((s, r) => s + r.currentHoldings, 0);
    const gValue    = group.reduce((s, r) => s + r.currentValueSol, 0);
    const gUpnl     = group.reduce((s, r) => s + r.upnlSol,         0);

    console.log(`\n  ${line.slice(0, 60)}`);
    console.log(`  GROUP ${g} TOTAL  ${fmtN(gSolIn, 2)} SOL in  |  ${fmtTok(gHolding)} tokens held  |  ${gUpnl >= 0 ? "+" : ""}${fmtN(gUpnl, 2)} SOL uPnL  (~${gUpnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(gUpnl * price.solUsd))})`);
    console.log();
  }

  // Grand totals
  const grandSolIn   = results.reduce((s, r) => s + r.totalSolSpent,   0);
  const grandHolding = results.reduce((s, r) => s + r.currentHoldings, 0);
  const grandValue   = results.reduce((s, r) => s + r.currentValueSol, 0);
  const grandUpnl    = results.reduce((s, r) => s + r.upnlSol,         0);
  const grandUpnlUsd = grandUpnl * price.solUsd;

  console.log(LINE);
  console.log(`  ALL 12 CABAL WALLETS — AGGREGATE`);
  console.log(line);
  console.log(`  Total SOL invested   ${fmtN(grandSolIn, 2)} SOL          (~${fmtUsd(grandSolIn * price.solUsd)})`);
  console.log(`  Total tokens held    ${fmtTok(grandHolding)} tokens  (${(grandHolding / SUPPLY * 100).toFixed(3)}% supply)`);
  console.log(`  Total current value  ${fmtN(grandValue, 2)} SOL          (~${fmtUsd(grandValue * price.solUsd)})`);
  console.log(`  Total uPnL           ${grandUpnl >= 0 ? "+" : ""}${fmtN(grandUpnl, 2)} SOL         (~${grandUpnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(grandUpnlUsd))})`);
  console.log(LINE);
  console.log();
}

main().catch(err => {
  console.error("❌", err.message);
  process.exit(1);
});
