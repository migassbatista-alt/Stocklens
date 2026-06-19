const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Simple in-memory rate limiter: max 20 requests per IP per hour
const rateLimits = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxRequests = 20;

  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  const limit = rateLimits.get(ip);

  if (now > limit.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (limit.count >= maxRequests) return false;

  limit.count++;
  return true;
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check site password
  const sitePassword = process.env.SITE_PASSWORD;
  const providedPassword = req.headers["x-site-password"];
  if (!sitePassword || providedPassword !== sitePassword) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Rate limiting
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Try again in an hour." });
  }

  // Build prompt from stock data
  const { stockData } = req.body;
  if (!stockData) {
    return res.status(400).json({ error: "Missing stockData" });
  }

  const s = stockData;
  const prompt = `You are a sell-side equity analyst. Analyse this stock and provide a concise investment summary covering: (1) Business quality & competitive moat, (2) Key financial metrics assessment, (3) Valuation verdict (cheap/fair/expensive), (4) Bull case vs Bear case, (5) Overall verdict and suggested action.

Company: ${s.name} (${s.ticker})
Sector: ${s.sector}
Current Price: $${s.price} | Market Cap: ${s.marketCap}
P/E: ${s.pe} | EPS: $${s.eps}
Revenue (LTM): ${s.revenue} | Net Income: ${s.netIncome} | FCF: ${s.freeCashFlow}
Gross Margin: ${s.grossMargin}% | Net Margin: ${s.netMargin}% | ROE: ${s.roe}%
Beta: ${s.beta} | 52W Range: $${s.week52Low} – $${s.week52High}
Description: ${s.description?.substring(0, 400)}

Be direct, analytical, and opinionated. Use clear section headings. Under 500 words.`;

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

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    return res.status(200).json({ analysis: data.content?.[0]?.text || "No analysis returned." });
  } catch (err) {
    console.error("Anthropic API error:", err);
    return res.status(500).json({ error: "Failed to fetch analysis." });
  }
}
