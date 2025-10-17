# LS-LMSR Market Simulator

A full-stack demo of **LMSR** and **LS-LMSR** (liquidity-scaled LMSR) automated market maker mechanics.
Create multi-outcome markets, set parameters, quote and execute trades on Sepolia, and visualize price/liquidity paths with preset scenarios.


<img width="1173" height="973" alt="Screenshot 2025-10-17 at 02 37 17" src="https://github.com/user-attachments/assets/c6d5beef-67e0-4b0c-8efa-307ee52b0a8b" />


---

## Live & Contracts

* **Frontend:** https://ls-lmsr-simulator.vercel.app/
* **Repository:** https://github.com/lavacakechef/LS-LMSR-Simulator

**Sepolia deployments**

* **AMM (LS-LMSR):** `0x750fcc8fa820653DDa0Aa2C0B5ed1fA2AeF11454`
  Explorer: [https://eth-sepolia.blockscout.com/address/0x750fcc8fa820653DDa0Aa2C0B5ed1fA2AeF11454](https://eth-sepolia.blockscout.com/address/0x750fcc8fa820653DDa0Aa2C0B5ed1fA2AeF11454)
* **mUSD (ERC-20 collateral):** `0x0b214Bc7733Efefe9662236F1Af1730A35dDD61E`
  Explorer: [https://eth-sepolia.blockscout.com/address/0x0b214Bc7733Efefe9662236F1Af1730A35dDD61E](https://eth-sepolia.blockscout.com/address/0x0b214Bc7733Efefe9662236F1Af1730A35dDD61E)

---

## Quickstart

```bash
# 1) Clone
git clone <your-repo-url>
cd <your-repo>

# 2) Environment
cp .env.example .env
# Edit .env:
# VITE_RPC_URL=<your_sepolia_rpc>
# VITE_AMM_ADDR=0x750fcc8fa820653DDa0Aa2C0B5ed1fA2AeF11454

# 3) Install & run
pnpm i         # or yarn / npm install
pnpm dev       # start the frontend
```

Open the app in your browser, connect a wallet on **Sepolia**, and you’re ready.

---

## How to Use

### 1) Get Collateral (mUSD)

* Use the app’s **Wallet Info** section or a faucet flow (if provided) to mint test **mUSD**, or transfer mUSD from another test wallet.
* The app displays your **Balance** and **Allowance** once connected.

### 2) Approve the AMM

* In **Wallet Info**, click **Approve AMM to spend collateral**.
  This sends an ERC-20 approval to the AMM so it can take payment for buys and disburse payout for sells.

### 3) Create a Market

In **Create New Market**:

* **Mechanism**

  * **LMSR (Fixed b)** — standard LMSR with constant liquidity parameter (b).
  * **LS-PROXY (Dynamic b)** — liquidity-scaled LMSR where (b) moves with total liquidity.
* **Outcomes (2–5)** — number of mutually exclusive outcomes.
* **Initial Liquidity (b₀)** — starting liquidity parameter.
* **Alpha (α)** — scaling slope for LS-PROXY (disabled for LMSR).
* Click **Create Market**. The new market id is shown and stored under **Recent Markets**.

### 4) Load Markets

In **Load Markets**:

* Enter a **Market ID (Primary)** to analyze and trade.
* Optionally enter a **Compare Market ID** to plot A/B side-by-side.
* Click **Load Market Data**.

You’ll see:

* **Prices table** with current outcome quantities (q_i) and prices (p_i).
* **Live price bar chart**.
* **Collateral / T / b_eff** cards.

### 5) Quote a Trade

In **Execute Trade**:

* Choose **Side** — Buy shares or Sell shares.
* Choose **Outcome** — index of the outcome to trade.
* Set **Quantity (ΔQ)** — number of shares to buy/sell.
* Set **Steps (K)** — curve discretization for the quote. Larger K ≈ finer integral approximation.
* Set **Slippage %** — tolerance for execution.
* Click **Get Quote**.

  * You’ll see **Cost** (for buys) or **Payout** (for sells).
  * A **Post-Trade Prices** bar chart appears for the quoted trade.
  * If a comparison market is loaded, you’ll see both A and B quotes.

### 6) Execute the Trade

* Click **Execute Trade** to send the transaction with the computed slippage bound.
* The **Transactions** panel records a short history and links to Blockscout.

### 7) Run Preset Scenarios

Use the **Scenario Runner**:

* **Same Outcome ×10 (ΔQ=1)** — accumulate outcome 0 ten times.
* **Alternating Outcomes (0↔1)** — buy 0/1/0/1… to compare oscillatory behavior.
* **Round-Trip (Buy then Sell)** — five buys then five sells on outcome 0.

After each step the app snapshots and plots:

* **p₀ over steps** (left chart) for Market A and Market B.
* **b(T) over steps** (right chart):

  * **LMSR** shows a **flat** line (b is constant).
  * **LS-PROXY** shows a **moving** line (b rises with net inflows, falls with outflows).

A small debug footer prints the last few points for verification.

---

## Math Overview

* **LMSR cost function**
  ( C(q) = b \cdot \ln!\left( \sum_i e^{q_i/b} \right) )

* **Price**
  ( p_i(q)= \dfrac{e^{q_i/b}}{\sum_j e^{q_j/b}} ) (prices sum to 1)

* **LS-LMSR (here via “LS-PROXY”)**
  ( b(T) = b_0 + \alpha T )
  The same LMSR price rule is used, but the liquidity parameter (b) evolves with the pool’s total liquidity (T). As (T) increases, (b) increases, making the curve shallower and reducing marginal price impact.

---

## LMSR vs LS-LMSR

| Property            | LMSR                    | LS-LMSR (LS-PROXY in this repo)                            |
| ------------------- | ----------------------- | ---------------------------------------------------------- |
| Liquidity parameter | Fixed (b)               | (b(T) = b_0 + \alpha T)                                    |
| Price impact        | Determined by fixed (b) | Inflows increase (b) → lower impact; outflows decrease (b) |
| Stability           | Static curve            | Adaptive curve that reflects market depth                  |
| Visual cue in app   | **b(T)** line is flat   | **b(T)** line moves with trading                           |

---

## Contract Interfaces (review)

**AMM**

* `createMarket(uint8 mech, uint8 n, uint256 b0Wad, uint256 alphaWad) → uint256 marketId`
* `state(uint256 marketId) → (meta, uint256[] q, uint256 T, uint256 bEff, uint256[] prices)`
* `prices(uint256 marketId) → uint256[]`
* `quoteBuy(uint256 marketId, uint8 outcome, uint256 dQWad, uint16 steps) → (uint256 costWad, uint256[] pricesAfter)`
* `quoteSell(uint256 marketId, uint8 outcome, uint256 dQWad, uint16 steps) → (int256 payoutWad, uint256[] pricesAfter)`
* `buy(uint256 marketId, uint8 outcome, uint256 dQWad, uint16 steps, uint256 maxCostWad)`
* `sell(uint256 marketId, uint8 outcome, uint256 dQWad, uint16 steps, uint256 minPayoutWad)`
* `collateralToken() → address`

**mUSD**

* Standard ERC-20: `balanceOf`, `transfer`, `approve`, `allowance`, etc.

*All monetary values are handled in WAD (1e18) units on-chain; the UI converts to floats for display.*

---

## Testing Guide

1. Create two markets:

   * **A:** LMSR with `b₀ = 5`
   * **B:** LS-PROXY with `b₀ = 5, α = 0.1`
2. Load both as **Market A** and **Market B**.
3. Run **Alternating Outcomes (0↔1)**.
   Expect **p₀** in both to oscillate, while **b(T)** rises slightly only in **B**.
4. Run **Round-Trip (Buy then Sell)** on **B**.
   Expect **b(T)** to increase during buys and drift back down during sells.
5. Use **Get Quote** to verify that the **Post-Trade Prices** bar chart reflects the expected shift before executing.

---

## Development

* **Frontend:** React, Tailwind, Recharts, viem.
* **Network:** Sepolia.
* **State/UX notes:**

  * The **Scenario Runner** is memoized and updates charts deterministically step-by-step.
  * The debug footer under the runner shows the last few data points for auditability.
  * Transactions are cached locally for quick access and cross-checking on Blockscout.

---

## Assumptions & Limitations

* Markets are for pricing demonstration; no oracle or resolution flow is included.
* Outcome shares are tracked internally; they are not separate ERC-20s.
* LS-PROXY uses a linear (b(T)) as a practical proxy for liquidity-scaled LMSR behavior.
* Quotes use a step-integral approximation; increase **K** for finer accuracy.

---

## Troubleshooting

* **Charts don’t update after trades**
  Ensure you loaded the correct **Market ID** and that transactions confirmed. Use the **Scenario Runner** footer to verify that new points are being appended.
* **Approval required**
  If **Allowance** shows `0.0000`, click **Approve AMM to spend collateral** in **Wallet Info**.
* **Invalid outcome index**
  Keep the **Outcome** field within `[0, n-1]` for the selected market.
* **RPC issues**
  Verify `VITE_RPC_URL` in `.env` points to a functioning Sepolia endpoint.

---

## License

MIT







