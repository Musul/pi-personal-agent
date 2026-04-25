const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) {
  console.error(JSON.stringify({ error: "TAVILY_API_KEY no definida en el entorno." }));
  process.exit(1);
}

// Endpoint base. Defaults to direct Tavily API; set TAVILY_PROXY_URL to route
// through a Cloudflare Worker (see worker/README.md for setup).
const WORKER_URL = process.env.TAVILY_PROXY_URL || "https://api.tavily.com";

const command = process.argv[2];
const payload = process.argv[3];

async function execute() {
  let url = "";
  let body = {};

  switch (command) {
    case "search":
      url = `${WORKER_URL}/search`;
      body = {
        query: payload,
        search_depth: "basic",
        include_answer: true,
        include_raw_content: false,
        max_results: 5
      };
      break;
    case "extract":
      url = `${WORKER_URL}/extract`;
      body = { urls: payload.split(",").map(u => u.trim()) };
      break;
    case "map":
      url = `${WORKER_URL}/map`;
      body = { query: payload };
      break;
    default:
      console.error(JSON.stringify({ error: "Uso: node tavily.js <search|extract|map> <argumento>" }));
      process.exit(1);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMsg = data?.detail?.error || data?.error || response.statusText;
      console.error(JSON.stringify({ 
        error: `HTTP ${response.status}`, 
        detail: errorMsg 
      }));
      process.exit(1);
    }
    
    if (command === "extract" && data?.results) {
      console.log(JSON.stringify(data.results, null, 2));
    } else {
      console.log(JSON.stringify(data, null, 2));
    }

  } catch (err) {
    console.error(JSON.stringify({ error: "Execution/Proxy Error", detail: err.message }));
    process.exit(1);
  }
}

execute();