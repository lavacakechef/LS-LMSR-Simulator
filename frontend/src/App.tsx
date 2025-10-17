import React, { useEffect, useState, useCallback, memo } from "react";
import { createPublicClient, createWalletClient, custom, http } from "viem";
import { sepolia } from "viem/chains";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LineChart,
  Line, 
  Legend
} from "recharts";

type RunPoint = { step: number; p0A?: number; p0B?: number; bA?: number; bB?: number };
type ScenarioRunnerProps = {
  account: `0x${string}` | null;
  walletClient: ReturnType<typeof createWalletClient> | null;
  marketIdA: number | "";
  marketIdB: number | "";
  stepsK: number;
  onAfterEach?: () => Promise<void>;
  onTxPush?: (t: {
    marketId: number; side: "buy" | "sell"; hash: `0x${string}`;
    outcome: number; qty: number; costOrPayout: number;
  }) => void;
};
const toPct = (x: bigint) => fromWad(x);

const ScenarioRunner = React.memo(function ScenarioRunner(props: ScenarioRunnerProps) {
  const {
    account, walletClient, marketIdA, marketIdB, stepsK, onAfterEach, onTxPush
  } = props;
  const [label, setLabel] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [series, setSeries] = useState<RunPoint[]>([]);
  const lastSeriesRef = React.useRef<RunPoint[] | null>(null);
  useEffect(() => {
    if (series.length > 0) lastSeriesRef.current = series;
  }, [series]);

  const dataToShow = series.length ? series : (lastSeriesRef.current ?? []);
  const chartKey = `${dataToShow.length}-${dataToShow.at(-1)?.step ?? "x"}`;

  const reset = () => {
    lastSeriesRef.current = null;
    setSeries([]);
  };

  const readState = async (mid: number) => {
    const res = await publicClient.readContract({ address: AMM_ADDRESS, abi: AMM_ABI, functionName: "state", args: [BigInt(mid)] }) as any;
    const [, , , bEff, prices] = res;
    return { b: fromWad(BigInt(bEff)), p0: toPct(prices[0]) };
  };

  const doTrade = async (mid: number, side: "buy"|"sell", outcome: number, dQ: number, stepNo: number) => {
    if (!walletClient || !account) throw new Error("Connect wallet");
    const fn = side === "buy" ? "buy" : "sell";
    const argsBase = [BigInt(mid), outcome, toWad(dQ), stepsK] as const;

    setLabel(`Market #${mid}: ${side.toUpperCase()} o${outcome} ΔQ=${dQ} (step ${stepNo})`);

    if (side === "buy") {
      const [cost] = await publicClient.readContract({
        address: AMM_ADDRESS, abi: AMM_ABI, functionName: "quoteBuy",
        args: [BigInt(mid), outcome, toWad(dQ), stepsK]
      }) as [bigint, bigint[]];
      const maxCost = (cost * 1005n) / 1000n; // +0.5% slippage
      const hash = await walletClient.writeContract({
        chain, address: AMM_ADDRESS, abi: AMM_ABI, functionName: fn, account, args: [...argsBase, maxCost]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await sleep(500);
      onTxPush?.({
      marketId: mid, side: "buy", hash, outcome, qty: dQ, costOrPayout: fromWad(cost),
    });
    } else {
      const [payout] = await publicClient.readContract({
        address: AMM_ADDRESS, abi: AMM_ABI, functionName: "quoteSell",
        args: [BigInt(mid), outcome, toWad(dQ), stepsK]
      }) as [bigint, bigint[]];
      const minPay = (payout * 995n) / 1000n; // -0.5% slippage
      const hash = await walletClient.writeContract({
        chain, address: AMM_ADDRESS, abi: AMM_ABI, functionName: fn, account, args: [...argsBase, minPay]
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await sleep(500);
      onTxPush?.({
        marketId: mid, side: "sell", hash, outcome, qty: dQ, costOrPayout: fromWad(payout),
      });
    }
  };

  const ensureAllowance = async () => {
    if (!walletClient || !account) throw new Error("Connect wallet");

    // read collateral token from AMM
    const collateral = await publicClient.readContract({
      address: AMM_ADDRESS,
      abi: AMM_ABI,
      functionName: "collateralToken",
    }) as `0x${string}`;

    // current allowance
    const current = await publicClient.readContract({
      address: collateral,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account, AMM_ADDRESS],
    }) as bigint;

    if (current === 0n) {
      setLabel("Approving collateral…");
      const hash = await walletClient.writeContract({
        chain,
        address: collateral,
        abi: ERC20_ABI,
        functionName: "approve",
        account,
        args: [AMM_ADDRESS, 2n ** 256n - 1n], // max
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  };

  // helper to snapshot A/B
  const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

  const snapshot = async (step: number) => {
    try {
      const pt: RunPoint = { step };

      if (marketIdA !== "") {
        const sA = await readState(Number(marketIdA));
        pt.p0A = sA.p0; pt.bA = sA.b;
      }
      if (marketIdB !== "") { 
        const sB = await readState(Number(marketIdB));
        pt.p0B = sB.p0; pt.bB = sB.b;
      }

      // simple sanity: at least one finite value
      const hasValue = [pt.p0A, pt.p0B, pt.bA, pt.bB].some(v => Number.isFinite(v));
      if (hasValue) {
        console.log("snapshot -> pushing point", pt);  
        setSeries(prev => [...prev, pt]);
      } else {
        console.warn("snapshot -> skipped empty point", pt);
      }
    } catch (e) {
      console.error("snapshot failed", e);
      setLabel(`Snapshot error: ${(e as Error).message}`);
    }
  };

  // Scenario 1: two-phase same-outcome accumulation
  const runSameOutcomePhases = async () => {
    if (marketIdA === "" && marketIdB === "") return alert("Load at least one market");
    setRunning(true); reset();
    await ensureAllowance();
    await snapshot(0);

    // Phase 1: five buys of ΔQ=1 on outcome 0
    for (let k = 1; k <= 5; k++) {
      if (marketIdA !== "") await doTrade(Number(marketIdA), "buy", 0, 1, k);
      if (marketIdB !== "") await doTrade(Number(marketIdB), "buy", 0, 1, k);
      if (onAfterEach) await onAfterEach();
      await snapshot(k);
    }
    // Phase 2: five more buys of ΔQ=1
    for (let k = 6; k <= 10; k++) {
      if (marketIdA !== "") await doTrade(Number(marketIdA), "buy", 0, 1, k);
      if (marketIdB !== "") await doTrade(Number(marketIdB), "buy", 0, 1, k);
      if (onAfterEach) await onAfterEach();
      await snapshot(k);
    }
    setRunning(false);
  };

  // Scenario 2: alternating outcomes (0,1,0,1,0,1)
  const runAlternating = async () => {
    if (marketIdA === "" && marketIdB === "") return alert("Load at least one market");
    setRunning(true); reset();
    await ensureAllowance();
    await snapshot(0);
    const seq = [0, 1, 0, 1, 0, 1];
    let step = 0;
    for (const out of seq) {
      step++;
      if (marketIdA !== "") await doTrade(Number(marketIdA), "buy", out, 1, step);
      if (marketIdB !== "") await doTrade(Number(marketIdB), "buy", out, 1, step);
      if (onAfterEach) await onAfterEach();
      await snapshot(step);
    }
    setRunning(false);
  };

  // Scenario 3: Round-trip — buy then sell back the same amounts
  const runRoundTrip = async () => {
    if (marketIdA === "" && marketIdB === "") return alert("Load at least one market");
    setRunning(true); reset();
    await ensureAllowance();
    await snapshot(0);

    // Phase 1: accumulate — five buys ΔQ=1 on outcome 0
    for (let k = 1; k <= 5; k++) {
      if (marketIdA !== "") await doTrade(Number(marketIdA), "buy", 0, 1, k);
      if (marketIdB !== "") await doTrade(Number(marketIdB), "buy", 0, 1, k);
      if (onAfterEach) await onAfterEach();
      await snapshot(k);
    }

    // Phase 2: unwind — five sells ΔQ=1 on outcome 0 (requires holdings from Phase 1)
    for (let k = 6; k <= 10; k++) {
      if (marketIdA !== "") await doTrade(Number(marketIdA), "sell", 0, 1, k);
      if (marketIdB !== "") await doTrade(Number(marketIdB), "sell", 0, 1, k);
      if (onAfterEach) await onAfterEach();
      await snapshot(k);
    }

    setRunning(false);
  };

  return (
    <Card className="mb-6">
      <h2 className="text-xl font-semibold mb-3 text-purple-300">Scenario Runner</h2>
      <div className="flex flex-wrap gap-3 mb-4">
        <Button onClick={runSameOutcomePhases} disabled={running} variant="secondary">
          Same Outcome ×10 (ΔQ=1)
        </Button>
        <Button onClick={runAlternating} disabled={running} variant="secondary">
          Alternating Outcomes (0↔1)
        </Button>
        <Button onClick={runRoundTrip} disabled={running} variant="secondary">
          Round-Trip (Buy then Sell)
        </Button>
        <Button onClick={reset} disabled={running} variant="danger">
          Reset Plots
        </Button>
      </div>

      <div className="text-sm text-gray-400 mb-3">
        {running ? (label || "Submitting and waiting for confirmations…") : "Idle"}
      </div>

      {(
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <div className="text-sm text-gray-400 mb-2">p₀ over steps</div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dataToShow} key={`p0-${chartKey}`}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="step" stroke="#9CA3AF" fontSize={12} />
                  <YAxis domain={[0, 1]} stroke="#9CA3AF" fontSize={12} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "8px" }}
                    formatter={(v: number) => v.toFixed(4)}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="p0A" name="A:p0" dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="p0B" name="B:p0" dot={false} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <div className="text-sm text-gray-400 mb-2">b(T) over steps</div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dataToShow} key={`b-${chartKey}`}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="step" stroke="#9CA3AF" fontSize={12} />
                  <YAxis stroke="#9CA3AF" fontSize={12} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "8px" }}
                    formatter={(v: number) => v.toFixed(4)}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="bA"  name="A:bEff" dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="bB"  name="B:bEff" dot={false} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
      <div className="mt-3 text-xs text-gray-400 font-mono">
        <div>points: {dataToShow.length}</div>
        <div>
          {dataToShow.slice(-5).map(p => 
            <div key={`dbg-${p.step}`}>
              step {p.step} — A: p0={p.p0A?.toFixed?.(4)} b={p.bA?.toFixed?.(4)} | 
              B: p0={p.p0B?.toFixed?.(4)} b={p.bB?.toFixed?.(4)}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
});

// ---------- ENV ----------
const RPC_URL = import.meta.env.VITE_RPC_URL as string | undefined;
const AMM_ADDRESS = (import.meta.env.VITE_AMM_ADDR as `0x${string}` | undefined) ??
  ("0x0000000000000000000000000000000000000000" as const);

// ---------- WAD helpers ----------
const WAD = 10n ** 18n;
const toWad = (x: number) => BigInt(Math.round(x * 1e6)) * (WAD / 1_000_000n);
const fromWad = (x?: bigint) => (x ? Number(x) / 1e18 : 0);

// ---------- ABIs ----------
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const AMM_ABI = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "mech", type: "uint8" },
      { name: "n", type: "uint8" },
      { name: "b0Wad", type: "uint256" },
      { name: "alphaWad", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "state",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      {
        components: [
          { name: "mech", type: "uint8" },
          { name: "n", type: "uint8" },
          { name: "b0Wad", type: "uint256" },
          { name: "alphaWad", type: "uint256" },
          { name: "collateral", type: "uint256" },
          { name: "closed", type: "bool" },
        ],
        type: "tuple",
      },
      { type: "uint256[]" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "prices",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "quoteBuy",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "outcome", type: "uint8" },
      { name: "dQWad", type: "uint256" },
      { name: "steps", type: "uint16" },
    ],
    outputs: [{ type: "uint256" }, { type: "uint256[]" }],
  },
  {
    type: "function",
    name: "quoteSell",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "outcome", type: "uint8" },
      { name: "dQWad", type: "uint256" },
      { name: "steps", type: "uint16" },
    ],
    outputs: [{ type: "int256" }, { type: "uint256[]" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "outcome", type: "uint8" },
      { name: "dQWad", type: "uint256" },
      { name: "steps", type: "uint16" },
      { name: "maxCostWad", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "outcome", type: "uint8" },
      { name: "dQWad", type: "uint256" },
      { name: "steps", type: "uint16" },
      { name: "minPayoutWad", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "collateralToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "userShares",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "user", type: "address" },
      { name: "outcome", type: "uint8" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ---------- Wallet / RPC clients ----------
const chain = sepolia;
const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain, transport });

function useWallet() {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [walletClient, setWalletClient] = useState<ReturnType<typeof createWalletClient> | null>(null);

  const connect = async () => {
    if (!window.ethereum) {
      alert("No injected wallet found (MetaMask, etc.)");
      return;
    }
    const wc = createWalletClient({ chain, transport: custom(window.ethereum) });
    const [addr] = await wc.requestAddresses();
    setAccount(addr);
    setWalletClient(wc);
  };

  const disconnect = () => {
    setAccount(null);
    setWalletClient(null);
  };

  return { account, walletClient, connect, disconnect };
}

// ---------- STYLED UI COMPONENTS ----------
const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`bg-gray-800 rounded-lg p-6 border border-gray-700 shadow-lg ${className}`}>
    {children}
  </div>
);

const Button: React.FC<{ 
  children: React.ReactNode; 
  onClick?: () => void; 
  variant?: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
  className?: string;
}> = ({ children, onClick, variant = "primary", disabled = false, className = "" }) => {
  const variants = {
    primary: "bg-purple-600 hover:bg-purple-700",
    secondary: "bg-gray-600 hover:bg-gray-700",
    success: "bg-green-600 hover:bg-green-700",
    danger: "bg-red-600 hover:bg-red-700",
  };
  
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-lg text-white font-medium transition-colors ${variants[variant]} disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
};

const Input: React.FC<{
  label?: string;
  type?: string;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  step?: string;
  min?: string | number;
  max?: string | number;
  disabled?: boolean;
}> = ({ label, type = "text", value, onChange, placeholder, step, min, max, disabled }) => (
  <div className="flex flex-col gap-1">
    {label && <label className="text-sm font-medium text-gray-300">{label}</label>}
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
    />
  </div>
);

const Select: React.FC<{
  label?: string;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: { value: string | number; label: string }[];
  disabled?: boolean;
}> = ({ label, value, onChange, options, disabled }) => (
  <div className="flex flex-col gap-1">
    {label && <label className="text-sm font-medium text-gray-300">{label}</label>}
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className="bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  </div>
);

// ---------- UI ----------
export default function App() {
  const { account, walletClient, connect, disconnect } = useWallet();

  const [showFormulas, setShowFormulas] = useState(false);
  const [marketId, setMarketId] = useState<number | "">("");
  const [compareMarketId, setCompareMarketId] = useState<number | "">("");
  const [n, setN] = useState(3);
  const [mech, setMech] = useState<0 | 1>(1);
  const [b0, setB0] = useState(5);
  const [alpha, setAlpha] = useState(0.1);
  const [steps, setSteps] = useState(16);

  const [state, setState] = useState<any | null>(null);
  const [stateB, setStateB] = useState<any | null>(null);
  const [collateralAddr, setCollateralAddr] = useState<`0x${string}` | null>(null);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [balance, setBalance] = useState<bigint>(0n);

  type TxItem = {
    marketId: number;
    side: "buy" | "sell" | "create";
    hash: `0x${string}`;
    outcome?: number;
    qty?: number;
    costOrPayout?: number;
    ts: number; // ms
  };

  const [recentMarkets, setRecentMarkets] = useState<number[]>(() => {
    try { return JSON.parse(localStorage.getItem("recentMarkets") || "[]"); } catch { return []; }
  });
  const [txs, setTxs] = useState<TxItem[]>(() => {
    try { return JSON.parse(localStorage.getItem("txs") || "[]"); } catch { return []; }
  });

  const pushRecentMarket = (id: number) => {
    setRecentMarkets(prev => {
      const next = [id, ...prev.filter(x => x !== id)].slice(0, 8);
      localStorage.setItem("recentMarkets", JSON.stringify(next));
      return next;
    });
  };

  const pushTx = (item: TxItem) => {
    setTxs(prev => {
      const next = [item, ...prev].slice(0, 20);
      localStorage.setItem("txs", JSON.stringify(next));
      return next;
    });
  };


  const refresh = useCallback(async () => {
    if (marketId !== "") {
      const mId = BigInt(marketId);
      const res = await publicClient.readContract({ address: AMM_ADDRESS, abi: AMM_ABI, functionName: "state", args: [mId] });
      const [meta, q, T, bEff, prices] = res as any;
      setState({ meta, q, T, bEff, prices });
    } else {
      setState(null);
    }

    if (compareMarketId !== "") {
      const mIdB = BigInt(compareMarketId);
      const resB = await publicClient.readContract({ address: AMM_ADDRESS, abi: AMM_ABI, functionName: "state", args: [mIdB] });
      const [metaB, qB, TB, bEffB, pricesB] = resB as any;
      setStateB({ meta: metaB, q: qB, T: TB, bEff: bEffB, prices: pricesB });
    } else {
      setStateB(null);
    }
  }, [marketId, compareMarketId]);

  useEffect(() => {
    (async () => {
      const addr = await publicClient.readContract({ address: AMM_ADDRESS, abi: AMM_ABI, functionName: "collateralToken" });
      setCollateralAddr(addr as `0x${string}`);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      if (!account || !collateralAddr) return;
      const [allow, bal] = await Promise.all([
        publicClient.readContract({ address: collateralAddr, abi: ERC20_ABI, functionName: "allowance", args: [account, AMM_ADDRESS] }),
        publicClient.readContract({ address: collateralAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
      ]);
      setAllowance(allow as bigint);
      setBalance(bal as bigint);
    })();
  }, [account, collateralAddr, state, stateB]);

  const create = async () => {
    if (!walletClient || !account) return alert("Connect wallet first");

    // simulate to get return value (marketId) and request
    const sim = await publicClient.simulateContract({
      chain,
      address: AMM_ADDRESS,
      abi: AMM_ABI,
      functionName: "createMarket",
      args: [mech, n, toWad(b0), mech === 0 ? 0n : toWad(alpha)],
      account,
    });
    const createdId = Number(sim.result as bigint);
    const hash = await walletClient.writeContract(sim.request);
    await publicClient.waitForTransactionReceipt({ hash });

    alert(`Created marketId = ${createdId} (tx: ${hash})`);
    setMarketId(createdId);
    pushRecentMarket(createdId);
    pushTx({ marketId: createdId, side: "create", hash, ts: Date.now() });
    await refresh();
  };


  const [tradeOutcome, setTradeOutcome] = useState(0);
  const [tradeQty, setTradeQty] = useState(2);
  const [slippage, setSlippage] = useState(0.5);
  const [side, setSide] = useState<"buy" | "sell">("buy");

  const [quoteCost, setQuoteCost] = useState<bigint | null>(null);
  const [postPrices, setPostPrices] = useState<bigint[] | null>(null);
  const [quoteCostB, setQuoteCostB] = useState<bigint | null>(null);
  const [postPricesB, setPostPricesB] = useState<bigint[] | null>(null);

  const quote = async () => {
    if (marketId === "") return alert("Enter marketId");
    const fn = side === "buy" ? "quoteBuy" : "quoteSell";
    const res = await publicClient.readContract({ 
      address: AMM_ADDRESS, 
      abi: AMM_ABI, 
      functionName: fn, 
      args: [BigInt(marketId), tradeOutcome, toWad(tradeQty), steps] 
    });
    
    if (side === "buy") {
      const [cost, pAfter] = res as [bigint, bigint[]];
      setQuoteCost(cost);
      setPostPrices(pAfter);
    } else {
      const [payout, pAfter] = res as [bigint, bigint[]];
      setQuoteCost(payout);
      setPostPrices(pAfter);
    }

    if (compareMarketId !== "") {
      const resB = await publicClient.readContract({ 
        address: AMM_ADDRESS, 
        abi: AMM_ABI, 
        functionName: fn, 
        args: [BigInt(compareMarketId), tradeOutcome, toWad(tradeQty), steps] 
      });
      if (side === "buy") {
        const [costB, pAfterB] = resB as [bigint, bigint[]];
        setQuoteCostB(costB);
        setPostPricesB(pAfterB);
      } else {
        const [payoutB, pAfterB] = resB as [bigint, bigint[]];
        setQuoteCostB(payoutB);
        setPostPricesB(pAfterB);
      }
    } else {
      setQuoteCostB(null);
      setPostPricesB(null);
    }
  };

  const approve = async () => {
    if (!walletClient || !account || !collateralAddr) return;
    const amount = 2n ** 256n - 1n;
    const hash = await walletClient.writeContract({
      chain,
      address: collateralAddr,
      abi: ERC20_ABI,
      functionName: "approve",
      account,
      args: [AMM_ADDRESS, amount]
    });
    alert(`Approval sent! Tx: ${hash}`);
  };

  const execute = async () => {
    if (!walletClient || !account || marketId === "" || quoteCost === null) return;
    const mId = BigInt(marketId);
    
    if (side === "buy") {
      const maxCost = (quoteCost * BigInt(1000 + Math.round(slippage * 10))) / 1000n;
      const hash = await walletClient.writeContract({
        chain,
        address: AMM_ADDRESS,
        abi: AMM_ABI,
        functionName: "buy",
        account,
        args: [mId, tradeOutcome, toWad(tradeQty), steps, maxCost]
      });

      pushTx({
        marketId: Number(mId),
        side: "buy",
        hash,
        outcome: tradeOutcome,
        qty: tradeQty,
        costOrPayout: fromWad(quoteCost), // cost preview used
        ts: Date.now(),
      });

      alert(`Buy executed! Tx: ${hash}`);
    } else {
      const minPay = (quoteCost * BigInt(1000 - Math.round(slippage * 10))) / 1000n;
      const hash = await walletClient.writeContract({
        chain,
        address: AMM_ADDRESS,
        abi: AMM_ABI,
        functionName: "sell",
        account,
        args: [mId, tradeOutcome, toWad(tradeQty), steps, minPay]
      });

      pushTx({
        marketId: Number(mId),
        side: "sell",
        hash,
        outcome: tradeOutcome,
        qty: tradeQty,
        costOrPayout: fromWad(quoteCost), // payout preview used
        ts: Date.now(),
      });

      alert(`Sell executed! Tx: ${hash}`);
    }
    
    await refresh();

    setPostPrices(null);
    setPostPricesB(null);
    setQuoteCost(null);
    setQuoteCostB(null);
  };

  const BarChartPrices: React.FC<{ label: string; prices: bigint[] | null }> = ({ label, prices }) => {
    if (!prices) return null;
    const data = prices.map((p, i) => ({ 
      name: `Outcome ${i}`, 
      price: fromWad(BigInt(p)) 
    }));
    
    return (
      <div className="mt-4">
        <div className="text-sm text-gray-400 mb-2">{label}</div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" stroke="#9CA3AF" fontSize={12} />
              <YAxis domain={[0, 1]} stroke="#9CA3AF" fontSize={12} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                formatter={(v: number) => v.toFixed(4)}
              />
              <Bar dataKey="price" fill="#8B5CF6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  const LivePriceChart: React.FC<{ label: string; s: any | null }> = ({ label, s }) => {
    if (!s) return null;
    const data = s.prices.map((p: bigint, i: number) => ({
      name: `Outcome ${i}`,
      price: fromWad(BigInt(p)),
    }));
    return (
      <div className="mt-4">
        <div className="text-sm text-gray-400 mb-2">{label}</div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis dataKey="name" stroke="#9CA3AF" fontSize={12} />
              <YAxis domain={[0, 1]} stroke="#9CA3AF" fontSize={12} />
              <Tooltip
                contentStyle={{ backgroundColor: "#1F2937", border: "1px solid #374151", borderRadius: "8px" }}
                formatter={(v: number) => v.toFixed(4)}
              />
              <Bar dataKey="price" fill="#8B5CF6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  const PricesTable: React.FC<{ s: any; title: string }> = ({ s, title }) => {
    if (!s) return <div className="text-gray-400 text-center py-8">No market loaded</div>;
    
    const { meta, q, T, bEff, prices } = s;
    const outcomeColors = ["text-green-400", "text-blue-400", "text-purple-400", "text-yellow-400", "text-pink-400"];
    
    return (
      <div>
        <h3 className="text-lg font-semibold text-purple-300 mb-3">{title}</h3>
        
        <div className="flex flex-wrap gap-2 mb-4">
          <span className="px-3 py-1 rounded-full bg-gray-700 text-sm">
            {meta.mech === 0 ? "LMSR" : "LS-PROXY"}
          </span>
          <span className="px-3 py-1 rounded-full bg-gray-700 text-sm">
            Outcomes: {meta.n}
          </span>
          <span className="px-3 py-1 rounded-full bg-gray-700 text-sm">
            b₀: {fromWad(BigInt(meta.b0Wad)).toFixed(2)}
          </span>
          {meta.mech === 1 && (
            <span className="px-3 py-1 rounded-full bg-gray-700 text-sm">
              α: {fromWad(BigInt(meta.alphaWad)).toFixed(4)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4 text-center">
          <div className="bg-gray-900 rounded-lg p-3">
            <div className="text-2xl font-bold text-purple-400">
              {fromWad(BigInt(T)).toFixed(2)}
            </div>
            <div className="text-xs text-gray-400 mt-1">Total Liquidity (T)</div>
          </div>
          <div className="bg-gray-900 rounded-lg p-3">
            <div className="text-2xl font-bold text-blue-400">
              {fromWad(BigInt(bEff)).toFixed(2)}
            </div>
            <div className="text-xs text-gray-400 mt-1">Effective b</div>
          </div>
          <div className="bg-gray-900 rounded-lg p-3">
            <div className="text-2xl font-bold text-green-400">
              {fromWad(BigInt(meta.collateral)).toFixed(4)}
            </div>
            <div className="text-xs text-gray-400 mt-1">Collateral</div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-600">
                <th className="text-left p-3 text-gray-400">Outcome</th>
                <th className="text-right p-3 text-gray-400">Quantity (q)</th>
                <th className="text-right p-3 text-gray-400">Price</th>
              </tr>
            </thead>
            <tbody>
              {q.map((qi: bigint, i: number) => (
                <tr key={i} className="border-b border-gray-700">
                  <td className="p-3">
                    <span className={`font-medium ${outcomeColors[i]}`}>
                      Outcome {String.fromCharCode(65 + i)}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono">{fromWad(BigInt(qi)).toFixed(6)}</td>
                  <td className="p-3 text-right font-mono">
                    <span className={outcomeColors[i]}>
                      {(fromWad(BigInt(prices[i])) * 100).toFixed(2)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const onAfterEach = useCallback(async () => {
      await refresh();
    }, [refresh]);

    const onTxPushMemo = useCallback((t: any) => {
      pushTx({ ...t, ts: Date.now() });
    }, [pushTx]);

      return (
        <div className="min-h-screen bg-gray-900 text-white">
          {/* Header */}
          <header className="bg-gradient-to-r from-purple-600 to-blue-600 p-6 shadow-lg">
            <div className="container mx-auto">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-4xl font-bold text-white mb-2">
                    LS-LMSR Market Simulator
                  </h1>
                  <p className="text-purple-100">
                    On-chain prediction market powered by LS-LMSR mechanism
                  </p>
                </div>
                
                <div className="flex items-center gap-3">
                  {account ? (
                    <>
                      <div className="bg-white/20 backdrop-blur px-4 py-2 rounded-lg">
                        <div className="text-xs text-purple-100">Connected</div>
                        <div className="font-mono text-sm">
                          {account.slice(0, 6)}...{account.slice(-4)}
                        </div>
                      </div>
                      <Button onClick={disconnect} variant="secondary">
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button onClick={connect}>
                      Connect Wallet
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex gap-3 mt-4">
                <Button
                  onClick={() => setShowFormulas(!showFormulas)}
                  variant="secondary"
                  className="text-sm"
                >
                  {showFormulas ? "Hide" : "Show"} Formulas
                </Button>
              </div>
            </div>
          </header>

          {/* Formulas Section */}
          {showFormulas && (
            <div className="container mx-auto px-6 py-6">
              <Card>
                <h2 className="text-2xl font-semibold mb-4 text-purple-300">
                  LS-LMSR Mathematical Foundation
                </h2>
                
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-sm">
                  <div>
                    <h3 className="font-semibold mb-2 text-green-400">Cost Function</h3>
                    <div className="bg-gray-900 p-4 rounded font-mono text-center">
                      C(q) = b × ln(∑ᵢ exp(qᵢ/b))
                    </div>
                    <p className="mt-2 text-gray-300">
                      Where <code className="bg-gray-700 px-1 rounded">q</code> is the share vector and 
                      <code className="bg-gray-700 px-1 rounded ml-1">b</code> is the liquidity parameter.
                    </p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold mb-2 text-blue-400">Price Function</h3>
                    <div className="bg-gray-900 p-4 rounded font-mono text-center">
                      pᵢ = exp(qᵢ/b) / ∑ⱼ exp(qⱼ/b)
                    </div>
                    <p className="mt-2 text-gray-300">
                      Probability-based pricing where all prices sum to 1.0.
                    </p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold mb-2 text-yellow-400">Liquidity Scaling</h3>
                    <div className="bg-gray-900 p-4 rounded font-mono text-center">
                      b(T) = b₀ + α × T
                    </div>
                    <p className="mt-2 text-gray-300">
                      Where <code className="bg-gray-700 px-1 rounded">α</code> is scaling parameter and 
                      <code className="bg-gray-700 px-1 rounded ml-1">T</code> is total liquidity.
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          )}

          <main className="container mx-auto px-6 py-8">
            {/* Wallet Info */}
            {account && collateralAddr && (
              <Card className="mb-6">
                <h2 className="text-xl font-semibold mb-3 text-purple-300">Wallet Info</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-gray-400">Collateral Token</div>
                    <div className="font-mono text-xs mt-1">{collateralAddr}</div>
                  </div>
                  <div>
                    <div className="text-gray-400">Balance</div>
                    <div className="font-mono text-lg text-green-400">{fromWad(balance).toFixed(4)}</div>
                  </div>
                  <div>
                    <div className="text-gray-400">Allowance</div>
                    <div className="font-mono text-lg text-blue-400">{fromWad(allowance).toFixed(4)}</div>
                  </div>
                </div>
                {allowance === 0n && (
                  <div className="mt-4">
                    <Button onClick={approve} variant="success" className="w-full">
                      Approve AMM to spend collateral
                    </Button>
                  </div>
                )}
              </Card>
            )}

            {/* Create Market */}
            <Card className="mb-6">
              <h2 className="text-2xl font-semibold mb-4 text-purple-300">Create New Market</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                <Select
                  label="Mechanism"
                  value={mech}
                  onChange={(e) => setMech(Number(e.target.value) as 0 | 1)}
                  options={[
                    { value: 0, label: "LMSR (Fixed b)" },
                    { value: 1, label: "LS-PROXY (Dynamic b)" },
                  ]}
                />
                
                <Input
                  label="Outcomes (2-5)"
                  type="number"
                  value={n}
                  onChange={(e) => setN(Number(e.target.value))}
                  min={2}
                  max={5}
                />
                
                <Input
                  label="Initial Liquidity (b₀)"
                  type="number"
                  value={b0}
                  onChange={(e) => setB0(Number(e.target.value))}
                  step="0.1"
                />
                
                <Input
                  label="Alpha (α)"
                  type="number"
                  value={alpha}
                  onChange={(e) => setAlpha(Number(e.target.value))}
                  step="0.01"
                  disabled={mech === 0}
                />
              </div>
              
              <Button onClick={create} className="w-full">
                Create Market
              </Button>
            </Card>

            {/* Load Markets */}
            <Card className="mb-6">
              <h2 className="text-2xl font-semibold mb-4 text-purple-300">Load Markets</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Input
                  label="Market ID (Primary)"
                  type="number"
                  value={marketId}
                  onChange={(e) => setMarketId(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="Enter market ID"
                />
                
                <Input
                  label="Compare Market ID (Optional)"
                  type="number"
                  value={compareMarketId}
                  onChange={(e) => setCompareMarketId(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="Compare with another market"
                />
                
                <div className="flex items-end">
                  <Button onClick={refresh} className="w-full">
                    Load Market Data
                  </Button>
                </div>
              </div>
            </Card>

            {/* Recent Markets & Tx History */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <Card>
                <h2 className="text-xl font-semibold mb-3 text-purple-300">Recent Markets</h2>
                {recentMarkets.length === 0 ? (
                  <div className="text-gray-400 text-sm">None yet — create one above.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {recentMarkets.map((id) => (
                      <button
                        key={id}
                        onClick={() => setMarketId(id)}
                        className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-sm"
                      >
                        #{id}
                      </button>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <h2 className="text-xl font-semibold mb-3 text-purple-300">Transactions</h2>
                {txs.length === 0 ? (
                  <div className="text-gray-400 text-sm">No transactions yet.</div>
                ) : (
                  <div className="max-h-64 overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-700">
                          <th className="p-2 text-left text-gray-400">When</th>
                          <th className="p-2 text-left text-gray-400">Type</th>
                          <th className="p-2 text-left text-gray-400">Market</th>
                          <th className="p-2 text-left text-gray-400">Details</th>
                          <th className="p-2 text-left text-gray-400">Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {txs.map((t, i) => (
                          <tr key={i} className="border-b border-gray-800">
                            <td className="p-2">{new Date(t.ts).toLocaleTimeString()}</td>
                            <td className="p-2">
                              <span className={
                                t.side === "buy" ? "text-green-400" :
                                t.side === "sell" ? "text-red-400" : "text-blue-400"
                              }>
                                {t.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="p-2">#{t.marketId}</td>
                            <td className="p-2 font-mono text-xs">
                              {t.side === "create"
                                ? "—"
                                : `o${t.outcome} ΔQ=${t.qty} ${t.side === "buy" ? "cost" : "payout"}≈${t.costOrPayout?.toFixed(6)}`}
                            </td>
                            <td className="p-2">
                              <a
                                href={`https://eth-sepolia.blockscout.com/tx/${t.hash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-400 underline text-xs"
                              >
                                {t.hash.slice(0, 6)}…{t.hash.slice(-4)}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>

            {/* Scenario Runner */}
            <ScenarioRunner
              account={account}
              walletClient={walletClient}
              marketIdA={marketId}
              marketIdB={compareMarketId}
              stepsK={steps}
              onAfterEach={onAfterEach}
              onTxPush={onTxPushMemo}
            />

            {/* Market States */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <Card>
                <PricesTable s={state} title="Market A" />
                <LivePriceChart label="Current Prices (Market A)" s={state} />
                <BarChartPrices label="Post-Trade Prices (Market A)" prices={postPrices} />
                {postPrices && state && (
                  <div className="mt-2 text-xs text-gray-400">
                    <div className="mb-1">Δp (post-trade − current):</div>
                    <ul className="grid grid-cols-3 gap-2">
                      {postPrices.map((pp, i) => {
                        const cur = state.prices[i] as bigint;
                        const dp = fromWad(pp) - fromWad(cur);
                        const color = dp >= 0 ? "text-green-400" : "text-red-400";
                        return (
                          <li key={i} className={`font-mono ${color}`}>
                            o{i}: {dp >= 0 ? "+" : ""}{dp.toFixed(6)}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </Card>
              
              <Card>
                <PricesTable s={stateB} title="Market B (Comparison)" />
                <LivePriceChart label="Current Prices (Market B)" s={stateB} />
                <BarChartPrices label="Post-Trade Prices (Market B)" prices={postPricesB} />
                {postPricesB && stateB && (
                <div className="mt-2 text-xs text-gray-400">
                  <div className="mb-1">Δp (post-trade − current):</div>
                  <ul className="grid grid-cols-3 gap-2">
                    {postPricesB.map((pp, i) => {
                      const cur = stateB.prices[i] as bigint;
                      const dp = fromWad(pp) - fromWad(cur);
                      const color = dp >= 0 ? "text-green-400" : "text-red-400";
                      return (
                        <li key={i} className={`font-mono ${color}`}>
                          o{i}: {dp >= 0 ? "+" : ""}{dp.toFixed(6)}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              </Card>
            </div>

            {/* Trading Interface */}
            <Card>
              <h2 className="text-2xl font-semibold mb-4 text-purple-300">Execute Trade</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
                <Select
                  label="Side"
                  value={side}
                  onChange={(e) => setSide(e.target.value as "buy" | "sell")}
                  options={[
                    { value: "buy", label: "Buy Shares" },
                    { value: "sell", label: "Sell Shares" },
                  ]}
                />
                
                <Input
                  label="Outcome"
                  type="number"
                  value={tradeOutcome}
                  onChange={(e) => setTradeOutcome(Number(e.target.value))}
                  min={0}
                />
                
                <Input
                  label="Quantity (ΔQ)"
                  type="number"
                  value={tradeQty}
                  onChange={(e) => setTradeQty(Number(e.target.value))}
                  step="0.1"
                />
                
                <Input
                  label="Steps (K)"
                  type="number"
                  value={steps}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  min={1}
                  max={64}
                />
                
                <Input
                  label="Slippage %"
                  type="number"
                  value={slippage}
                  onChange={(e) => setSlippage(Number(e.target.value))}
                  step="0.1"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="text-sm text-gray-400 mb-2">Market A Quote</div>
                  {quoteCost !== null ? (
                    <div className="text-2xl font-bold text-yellow-400">
                      {side === "buy" ? "Cost: " : "Payout: "}
                      {fromWad(quoteCost).toFixed(6)}
                    </div>
                  ) : (
                    <div className="text-gray-500">Click Quote to see price</div>
                  )}
                </div>
                
                <div className="bg-gray-900 rounded-lg p-4">
                  <div className="text-sm text-gray-400 mb-2">Market B Quote</div>
                  {quoteCostB !== null ? (
                    <div className="text-2xl font-bold text-blue-400">
                      {side === "buy" ? "Cost: " : "Payout: "}
                      {fromWad(quoteCostB).toFixed(6)}
                    </div>
                  ) : (
                    <div className="text-gray-500">Load comparison market</div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Button onClick={quote} variant="secondary">
                  Get Quote
                </Button>
                <Button onClick={execute} variant="success">
                  Execute Trade
                </Button>
              </div>
            </Card>
          </main>
        </div>
      );
    }