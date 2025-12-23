import { SignClient } from "@walletconnect/sign-client";
import { ethers } from "ethers";

// ⚠️ Replace with your WalletConnect Project ID from https://cloud.walletconnect.com
const PROJECT_ID = process.env.PROJECT_ID || "YOUR_PROJECT_ID"; 

// ⚠️ Replace with your private key or use a random one for testing
const privateKey = process.env.PRIVATE_KEY || ethers.Wallet.createRandom().privateKey;
const wallet = new ethers.Wallet(privateKey);

console.log(`Working with Address: ${wallet.address}`);

const client = await SignClient.init({
  projectId: PROJECT_ID,
  logger: "error",
  metadata: {
    name: "Headless Wallet",
    description: "A CLI-based headless wallet",
    url: "https://my-wallet.com",
    icons: ["https://walletconnect.com/walletconnect-logo.png"],
  },
});

// 1. Handle Session Proposals
client.on("session_proposal", async (proposal) => {
  const { id, params } = proposal;
  console.log("📥 Received Session Proposal:", params.proposer.metadata.name);

  // Approve session with the requested chains
  const namespaces = {};
  const required = params.requiredNamespaces || {};
  const optional = params.optionalNamespaces || {};

  const allNamespaces = { ...required, ...optional };

  Object.keys(allNamespaces).forEach((key) => {
    const chains = allNamespaces[key].chains || ["eip155:1"]; // Default to Mainnet if not specified
    const accounts = chains.map((chain) => `${chain}:${wallet.address}`);
    
    namespaces[key] = {
      accounts,
      methods: allNamespaces[key].methods || [],
      events: allNamespaces[key].events || [],
    };
  });

  const { topic, acknowledged } = await client.approve({
    id,
    namespaces,
  });

  console.log("✅ Session Approved! Topic:", topic);
  await acknowledged();
  console.log("🔗 Session Acknowledged");
});

// 2. Handle Session Requests (Signing)
client.on("session_request", async (event) => {
  const { topic, params, id } = event;
  const { request } = params;

  console.log(`📩 Received Request: ${request.method}`);

  try {
    let result;
    if (request.method === "personal_sign") {
      const message = request.params[0];
      // personal_sign message is usually hex encoded bytes
      const data = ethers.isHexString(message) ? ethers.getBytes(message) : message;
      
      console.log("📝 Signing Message:", ethers.isHexString(message) ? ethers.toUtf8String(message) : message);
      result = await wallet.signMessage(data);
    } else if (request.method === "eth_signTypedData" || request.method === "eth_signTypedData_v4") {
      // Basic implementation for typed data
      const [address, data] = request.params;
      const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
      result = await wallet.signTypedData(parsedData.domain, parsedData.types, parsedData.message);
    } else {
      throw new Error(`Method ${request.method} not supported`);
    }

    await client.respond({
      topic,
      response: {
        id,
        jsonrpc: "2.0",
        result,
      },
    });
    console.log("📤 Response sent");
  } catch (err) {
    console.error("❌ Signing failed:", err.message);
    await client.respond({
      topic,
      response: {
        id,
        jsonrpc: "2.0",
        error: {
          code: 5000,
          message: err.message,
        },
      },
    });
  }
});

// 3. Handle Disconnect
client.on("session_delete", () => {
  console.log("🔌 Session disconnected");
  process.exit(0);
});

// 4. Initiate Pairing
const uri = process.argv[2];
if (!uri) {
  console.log("\n🚀 Headless Wallet Started");
  console.log("Usage: node wallet.js \"wc:...\"");
} else {
  console.log("🔗 Initiating pairing...");
  try {
    await client.pair({ uri });
    console.log("⏳ Pairing initiated, waiting for proposal...");
  } catch (err) {
    console.error("❌ Pairing failed:", err.message);
    process.exit(1);
  }
}
