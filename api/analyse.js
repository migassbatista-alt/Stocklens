
// Vercel serverless function: handles BOTH FMP data fetching and Claude AI analysis
// Keeps both API keys server-side (never exposed to browser)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-site-password");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Password check
  const sitePassword = process.env.SITE_PASSWORD;
  const provided = req.headers["x-site-password"];
  if (sitePassword && provided !== sitePassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const action = body.action;

  // ─────────────────────────────────────────────
  // ACTION 1: Fetch stock data from FMP
  // ─────────────────────────────────────────────
  if (action === "fetchStock") {
    const ticker = (body.ticker || "").toUpperCase().trim();
    if (!ticker) return res.status(400).json({ error: "Missing ticker" });

    const FMP_KEY = process.env.FMP_API_KEY;
    if (!FMP_KEY) return res.status(500).json({ error: "FMP key not configured" });

    const base = "https://financialmodelingprep.com/stable";

    try {
      // Fetch quote (free), income statement (free), cash flow (free)
      const [quoteRes, incomeRes, cashRes] = await Promise.all([
        fetch(`${base}/quote?symbol=${ticker}&apikey=${FMP_KEY}`).then(r => r.json()).catch(() => null),
        fetch(`${base}/income-statement?symbol=${ticker}&limit=5&apikey=${FMP_KEY}`).then(r => r.json()).catch(() => null),
        fetch(`${base}/cash-flow-statement?symbol=${ticker}&limit=5&apikey=${FMP_KEY}`).then(r => r.json()).catch(() => null),
      ]);

      const q = Array.isArray(quoteRes) ? quoteRes[0] : quoteRes;
      if (!q || q["Error Message"] || q.error) {
        return res.status(404).json({ error: "Ticker not found or endpoint unavailable" });
      }

      const income = Array.isArray(incomeRes) ? incomeRes : [];
      const cash = Array.isArray(cashRes) ? cashRes : [];

      const i0 = income[0] || {};
      const revenue = i0.revenue;
      const grossProfit = i0.grossProfit;
      const netIncome = i0.netIncome;
      const grossMargin = revenue && grossProfit ? (grossProfit / revenue) * 100 : null;
      const netMargin = revenue && netIncome ? (netIncome / revenue) * 100 : null;

      const revenueHistory = income.map(x => x.revenue).reverse();
      const earningsHistory = income.map(x => x.netIncome).reverse();
      const fcfHistory = cash.map(x => x.freeCashFlow).reverse();
      const years = income.map(x => new Date(x.date).getFullYear()).reverse();

      const stock = {
        name: q.name || ticker,
        ticker: q.symbol || ticker,
        exchange: q.exchange || "",
        sector: q.sector || "",
        price: q.price,
        change: q.change,
        changePct: q.changePercentage,
        marketCap: q.marketCap,
        pe: q.pe,
        eps: q.eps,
        revenue,
        netIncome,
        freeCashFlow: cash[0]?.freeCashFlow,
        grossMargin,
        netMargin,
        roe: null,
        beta: null,
        dividendYield: null,
        week52High: q.yearHigh,
        week52Low: q.yearLow,
        description: "",
        revenueHistory, earningsHistory, fcfHistory, years,
      };

      return res.status(200).json({ stock });
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch from FMP: " + err.message });
    }
  }

  // ─────────────────────────────────────────────
  // ACTION 2: Generate AI analysis with Claude
  // ─────────────────────────────────────────────
  const { stockData } = body;
  if (!stockData) return res.status(400).json({ error: "Missing stockData" });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "Anthropic key not configured" });

  const s = stockData;
  const prompt = `You are a sell-side equity analyst. Analyse this stock concisely covering: (1) Business quality & moat, (2) Financial metrics, (3) Valuation verdict, (4) Bull vs Bear case, (5) Overall verdict.

Company: ${s.name} (${s.ticker}) | Sector: ${s.sector}
Price: $${s.price} | Market Cap: ${s.marketCap} | P/E: ${s.pe} | EPS: $${s.eps}
Revenue: ${s.revenue} | Net Income: ${s.netIncome} | FCF: ${s.freeCashFlow}
Gross Margin: ${s.grossMargin}% | Net Margin: ${s.netMargin}%
52W: $${s.week52Low}–$${s.week52High}

Be direct and opinionated. Use clear headings. Under 500 words.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });
    return res.status(200).json({ analysis: data.content?.[0]?.text || "No analysis returned." });
  } catch (err) {
    return res.status(500).json({ error: "Failed to reach Anthropic API." });
  }
}
