// Vercel serverless function: fetches stock data from FMP or Yahoo Finance, plus Claude AI analysis
// Both API keys stay server-side (never exposed to browser)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-site-password");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const sitePassword = process.env.SITE_PASSWORD;
  const provided = req.headers["x-site-password"];
  if (sitePassword && provided !== sitePassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const action = body.action;

  // ─────────────────────────────────────────────
  // ACTION: Fetch stock data (FMP or Yahoo)
  // ─────────────────────────────────────────────
  if (action === "fetchStock") {
    const ticker = (body.ticker || "").toUpperCase().trim();
    const source = body.source === "yahoo" ? "yahoo" : "fmp";
    if (!ticker) return res.status(400).json({ error: "Missing ticker" });

    try {
      const stock = source === "yahoo"
        ? await fetchFromYahoo(ticker)
        : await fetchFromFMP(ticker);

      if (!stock) return res.status(404).json({ error: `No data for ${ticker} from ${source}` });
      return res.status(200).json({ stock, source });
    } catch (err) {
      return res.status(500).json({ error: `${source} fetch failed: ${err.message}` });
    }
  }

  // ─────────────────────────────────────────────
  // ACTION: Claude AI analysis
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
52W: $${s.week52Low}-$${s.week52High}

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

// ─────────────────────────────────────────────
// FMP fetcher
// ─────────────────────────────────────────────
async function fetchFromFMP(ticker) {
  const FMP_KEY = process.env.FMP_API_KEY;
  if (!FMP_KEY) throw new Error("FMP key not configured");
  const base = "https://financialmodelingprep.com/stable";

  const quoteResp = await fetch(`${base}/quote?symbol=${ticker}&apikey=${FMP_KEY}`);
  const quoteText = await quoteResp.text();
  let quoteJson;
  try { quoteJson = JSON.parse(quoteText); }
  catch { throw new Error("FMP returned non-JSON (likely plan limit): " + quoteText.substring(0, 80)); }

  const q = Array.isArray(quoteJson) ? quoteJson[0] : quoteJson;
  if (!q || q["Error Message"] || q.price === undefined) return null;

  // Optional statements
  let income = [], cash = [];
  try {
    const r = await fetch(`${base}/income-statement?symbol=${ticker}&limit=5&apikey=${FMP_KEY}`);
    const j = await r.json();
    if (Array.isArray(j)) income = j;
  } catch {}
  try {
    const r = await fetch(`${base}/cash-flow-statement?symbol=${ticker}&limit=5&apikey=${FMP_KEY}`);
    const j = await r.json();
    if (Array.isArray(j)) cash = j;
  } catch {}

  const i0 = income[0] || {};
  const revenue = i0.revenue ?? null;
  const grossProfit = i0.grossProfit ?? null;
  const netIncome = i0.netIncome ?? null;

  return {
    name: q.name || ticker,
    ticker: q.symbol || ticker,
    exchange: q.exchange || "",
    sector: q.sector || "",
    price: q.price,
    change: q.change ?? null,
    changePct: q.changePercentage ?? q.changesPercentage ?? null,
    marketCap: q.marketCap ?? null,
    pe: q.pe ?? null,
    eps: q.eps ?? null,
    revenue,
    netIncome,
    freeCashFlow: cash[0]?.freeCashFlow ?? null,
    grossMargin: revenue && grossProfit ? (grossProfit / revenue) * 100 : null,
    netMargin: revenue && netIncome ? (netIncome / revenue) * 100 : null,
    roe: null,
    beta: null,
    dividendYield: null,
    week52High: q.yearHigh ?? null,
    week52Low: q.yearLow ?? null,
    description: "",
    revenueHistory: income.map(x => x.revenue).reverse(),
    earningsHistory: income.map(x => x.netIncome).reverse(),
    fcfHistory: cash.map(x => x.freeCashFlow).reverse(),
    years: income.map(x => new Date(x.date).getFullYear()).reverse(),
  };
}

// ─────────────────────────────────────────────
// Yahoo Finance fetcher (no API key needed)
// ─────────────────────────────────────────────
async function fetchFromYahoo(ticker) {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

  // quoteSummary gives fundamentals; chart gives price fallback
  const modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,incomeStatementHistory,cashflowStatementHistory";
  const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;

  let summary = null;
  try {
    const r = await fetch(summaryUrl, { headers });
    const j = await r.json();
    summary = j?.quoteSummary?.result?.[0];
  } catch {}

  // Fallback to chart endpoint for at least price
  let chartMeta = null;
  if (!summary) {
    try {
      const cr = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`, { headers });
      const cj = await cr.json();
      chartMeta = cj?.chart?.result?.[0]?.meta;
    } catch {}
    if (!chartMeta) return null;
  }

  const price = summary?.price || {};
  const sd = summary?.summaryDetail || {};
  const ks = summary?.defaultKeyStatistics || {};
  const fd = summary?.financialData || {};
  const prof = summary?.assetProfile || {};

  const v = o => (o && typeof o === "object" && "raw" in o ? o.raw : (o ?? null));

  // Build revenue / earnings / FCF history from statements
  const incHist = summary?.incomeStatementHistory?.incomeStatementHistory || [];
  const cashHist = summary?.cashflowStatementHistory?.cashflowStatements || [];
  const revenueHistory = incHist.map(x => v(x.totalRevenue)).reverse();
  const earningsHistory = incHist.map(x => v(x.netIncome)).reverse();
  const fcfHistory = cashHist.map(x => v(x.totalCashFromOperatingActivities)).reverse();
  const years = incHist.map(x => x.endDate?.fmt ? new Date(x.endDate.fmt).getFullYear() : null).reverse();

  const curPrice = v(price.regularMarketPrice) ?? chartMeta?.regularMarketPrice ?? null;
  if (curPrice === null) return null;

  return {
    name: price.longName || price.shortName || chartMeta?.symbol || ticker,
    ticker: price.symbol || chartMeta?.symbol || ticker,
    exchange: price.exchangeName || chartMeta?.exchangeName || "",
    sector: prof.sector || "",
    price: curPrice,
    change: v(price.regularMarketChange),
    changePct: v(price.regularMarketChangePercent) !== null ? v(price.regularMarketChangePercent) * 100 : null,
    marketCap: v(price.marketCap) ?? v(sd.marketCap),
    pe: v(sd.trailingPE) ?? v(ks.forwardPE),
    eps: v(ks.trailingEps),
    revenue: v(fd.totalRevenue),
    netIncome: earningsHistory.length ? earningsHistory[earningsHistory.length - 1] : null,
    freeCashFlow: v(fd.freeCashflow),
    grossMargin: v(fd.grossMargins) !== null ? v(fd.grossMargins) * 100 : null,
    netMargin: v(fd.profitMargins) !== null ? v(fd.profitMargins) * 100 : null,
    roe: v(fd.returnOnEquity) !== null ? v(fd.returnOnEquity) * 100 : null,
    beta: v(sd.beta) ?? v(ks.beta),
    dividendYield: v(sd.dividendYield) !== null ? v(sd.dividendYield) * 100 : 0,
    week52High: v(sd.fiftyTwoWeekHigh),
    week52Low: v(sd.fiftyTwoWeekLow),
    description: prof.longBusinessSummary || "",
    revenueHistory: revenueHistory.filter(x => x != null),
    earningsHistory: earningsHistory.filter(x => x != null),
    fcfHistory: fcfHistory.filter(x => x != null),
    years: years.filter(x => x != null),
  };
}
