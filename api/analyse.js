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

  const { stockData } = req.body || {};
  if (!stockData) return res.status(400).json({ error: "Missing stockData" });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not configured" });

  const s = stockData;
  const prompt = `You are a sell-side equity analyst. Analyse this stock concisely covering: (1) Business quality & moat, (2) Financial metrics, (3) Valuation verdict, (4) Bull vs Bear case, (5) Overall verdict.

Company: ${s.name} (${s.ticker}) | Sector: ${s.sector}
Price: $${s.price} | Market Cap: ${s.marketCap} | P/E: ${s.pe} | EPS: $${s.eps}
Revenue: ${s.revenue} | Net Income: ${s.netIncome} | FCF: ${s.freeCashFlow}
Gross Margin: ${s.grossMargin}% | Net Margin: ${s.netMargin}% | ROE: ${s.roe}%
Beta: ${s.beta} | 52W: $${s.week52Low}–$${s.week52High}
${s.description?.substring(0, 300)}

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
