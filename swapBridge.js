import { ethers } from 'ethers';
import { getChain, getProvider } from './chains.js';

const LIFI_API_BASE = 'https://li.quest/v1';
const NATIVE_TOKEN_ADDR = '0x0000000000000000000000000000000000000000';

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function transfer(address to, uint amount) returns (bool)",
    "function approve(address spender, uint amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

// In-memory cache for token lists per chain
const tokenCache = new Map();

export async function getTokensForChain(chainId) {
    const cId = Number(chainId);
    if (tokenCache.has(cId)) {
        return tokenCache.get(cId);
    }

    const chain = getChain(cId);
    const nativeSymbol = chain ? chain.currency : 'ETH';
    const nativeName = chain ? `${chain.name} Native Token` : 'Native Coin';

    const defaultTokens = [
        {
            address: NATIVE_TOKEN_ADDR,
            symbol: nativeSymbol,
            name: nativeName,
            decimals: 18,
            isNative: true,
            logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png'
        }
    ];

    try {
        const res = await fetch(`${LIFI_API_BASE}/tokens?chains=${cId}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
            const data = await res.json();
            const chainTokens = data.tokens && data.tokens[String(cId)];
            if (Array.isArray(chainTokens) && chainTokens.length > 0) {
                // Ensure native token is at top
                const formatted = [];
                const seen = new Set();

                // Add native first
                formatted.push(defaultTokens[0]);
                seen.add(NATIVE_TOKEN_ADDR.toLowerCase());

                // Sort: major assets first, then alphabetically
                const sorted = [...chainTokens].sort((a, b) => {
                    const aMajor = a.tags?.includes('major_asset') || ['USDC', 'USDT', 'WETH', 'WBTC', 'DAI'].includes(a.symbol);
                    const bMajor = b.tags?.includes('major_asset') || ['USDC', 'USDT', 'WETH', 'WBTC', 'DAI'].includes(b.symbol);
                    if (aMajor && !bMajor) return -1;
                    if (!aMajor && bMajor) return 1;
                    return (a.symbol || '').localeCompare(b.symbol || '');
                });

                for (const t of sorted) {
                    const addrLow = (t.address || '').toLowerCase();
                    if (!addrLow || seen.has(addrLow)) continue;
                    seen.add(addrLow);

                    formatted.push({
                        address: t.address,
                        symbol: t.symbol,
                        name: t.name || t.symbol,
                        decimals: t.decimals || 18,
                        priceUSD: t.priceUSD ? parseFloat(t.priceUSD) : null,
                        logoURI: t.logoURI || null,
                        isNative: t.address === NATIVE_TOKEN_ADDR
                    });
                }

                tokenCache.set(cId, formatted);
                return formatted;
            }
        }
    } catch (e) {
        // Fallback to default tokens
    }

    tokenCache.set(cId, defaultTokens);
    return defaultTokens;
}

/**
 * Fetch a comprehensive Swap or Bridge Quote from LI.FI
 */
export async function getQuote({
    fromChainId,
    toChainId,
    fromTokenAddress,
    toTokenAddress,
    fromAmount, // human-readable string (e.g. '0.5')
    fromAddress,
    slippage = 0.005 // 0.5%
}) {
    if (!fromChainId || !toChainId || !fromTokenAddress || !toTokenAddress || !fromAmount || !fromAddress) {
        throw new Error('Missing required quote parameters.');
    }

    const fromChain = getChain(fromChainId);
    const toChain = getChain(toChainId);

    if (!fromChain) throw new Error(`Source chain ${fromChainId} not found`);
    if (!toChain) throw new Error(`Destination chain ${toChainId} not found`);

    // Resolve decimals for source token
    const tokens = await getTokensForChain(fromChainId);
    const srcToken = tokens.find(t => t.address.toLowerCase() === fromTokenAddress.toLowerCase()) || {
        decimals: 18,
        symbol: fromTokenAddress === NATIVE_TOKEN_ADDR ? fromChain.currency : 'TOKEN'
    };

    const fromAmountWei = ethers.parseUnits(String(fromAmount), srcToken.decimals).toString();

    const queryParams = new URLSearchParams({
        fromChain: String(fromChainId),
        toChain: String(toChainId),
        fromToken: fromTokenAddress,
        toToken: toTokenAddress,
        fromAmount: fromAmountWei,
        fromAddress: fromAddress,
        slippage: String(slippage)
    });

    const url = `${LIFI_API_BASE}/quote?${queryParams.toString()}`;

    let response;
    try {
        response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(12000)
        });
    } catch (e) {
        throw new Error(`Quote network request failed: ${e.message}`);
    }

    const data = await response.json();

    if (!response.ok || !data.estimate) {
        let errorMsg = data.message || data.error || 'No route found for this pair/amount.';
        if (typeof errorMsg === 'string' && errorMsg.includes('must be equal to one of the allowed values')) {
            errorMsg = `Cross-chain bridge aggregation is not available for ${toChain.name} (Chain ID ${toChainId}) or ${fromChain.name}. Use the chain's official canonical bridge portal.`;
        }
        throw new Error(`Quote Error: ${errorMsg}`);
    }

    const action = data.action;
    const estimate = data.estimate;
    const toolDetails = data.toolDetails || { name: data.tool || 'Direct Bridge' };

    const toDecimals = action.toToken?.decimals || 18;
    const fromDecimals = action.fromToken?.decimals || srcToken.decimals;

    const fromAmountFormatted = ethers.formatUnits(action.fromAmount, fromDecimals);
    const toAmountFormatted = ethers.formatUnits(estimate.toAmount, toDecimals);
    const toAmountMinFormatted = ethers.formatUnits(estimate.toAmountMin, toDecimals);

    // Compute exchange rate
    const fromNum = parseFloat(fromAmountFormatted);
    const toNum = parseFloat(toAmountFormatted);
    const rate = fromNum > 0 ? (toNum / fromNum) : 0;
    const inverseRate = toNum > 0 ? (fromNum / toNum) : 0;

    // Gas & fee calculations
    let gasCostUSD = 0;
    if (estimate.gasCosts && Array.isArray(estimate.gasCosts)) {
        for (const g of estimate.gasCosts) {
            gasCostUSD += parseFloat(g.amountUSD || 0);
        }
    }

    let feeCostUSD = 0;
    if (estimate.feeCosts && Array.isArray(estimate.feeCosts)) {
        for (const f of estimate.feeCosts) {
            feeCostUSD += parseFloat(f.amountUSD || 0);
        }
    }

    const isCrossChain = Number(fromChainId) !== Number(toChainId);

    // Duration formatting
    let durationFormatted = 'Instant (<15s)';
    const sec = estimate.executionDuration || 0;
    if (sec > 60) {
        durationFormatted = `~${Math.ceil(sec / 60)} mins (${sec}s)`;
    } else if (sec > 0) {
        durationFormatted = `~${sec} seconds`;
    }

    const isNative = fromTokenAddress.toLowerCase() === NATIVE_TOKEN_ADDR.toLowerCase();
    const spenderAddress = data.transactionRequest?.to;

    return {
        raw: data,
        isCrossChain,
        fromChain: {
            id: fromChain.chainId,
            name: fromChain.name,
            symbol: fromChain.currency
        },
        toChain: {
            id: toChain.chainId,
            name: toChain.name,
            symbol: toChain.currency
        },
        fromToken: {
            address: fromTokenAddress,
            symbol: action.fromToken?.symbol || srcToken.symbol,
            decimals: fromDecimals,
            priceUSD: action.fromToken?.priceUSD ? parseFloat(action.fromToken.priceUSD) : null
        },
        toToken: {
            address: toTokenAddress,
            symbol: action.toToken?.symbol || 'TOKEN',
            decimals: toDecimals,
            priceUSD: action.toToken?.priceUSD ? parseFloat(action.toToken.priceUSD) : null
        },
        fromAmount: fromAmountFormatted,
        fromAmountWei: action.fromAmount,
        toAmount: toAmountFormatted,
        toAmountMin: toAmountMinFormatted,
        exchangeRate: `1 ${action.fromToken?.symbol || 'SRC'} ≈ ${rate.toFixed(6)} ${action.toToken?.symbol || 'DST'}`,
        inverseRate: `1 ${action.toToken?.symbol || 'DST'} ≈ ${inverseRate.toFixed(6)} ${action.fromToken?.symbol || 'SRC'}`,
        provider: toolDetails.name || data.tool,
        toolKey: data.tool,
        executionDuration: sec,
        durationFormatted,
        gasCostUSD: gasCostUSD.toFixed(2),
        feeCostUSD: feeCostUSD.toFixed(2),
        totalFeesUSD: (gasCostUSD + feeCostUSD).toFixed(2),
        slippagePct: (slippage * 100).toFixed(2) + '%',
        isNative,
        spenderAddress,
        transactionRequest: data.transactionRequest
    };
}

/**
 * Execute Quote (Handles Allowance check, Approval, and Transaction broadcast)
 */
export async function executeQuote(signer, quote, onStatus = () => {}) {
    if (!signer) throw new Error('No signer provided');
    if (!quote || !quote.transactionRequest) throw new Error('Invalid quote transaction request');

    const userAddress = await signer.getAddress();
    const provider = signer.provider || getProvider(quote.fromChain.id);
    const connectedSigner = signer.connect ? signer.connect(provider) : signer;

    // Check token allowance if ERC20
    if (!quote.isNative) {
        onStatus({ step: 'checking_allowance', message: 'Checking token allowance...' });
        const tokenContract = new ethers.Contract(quote.fromToken.address, ERC20_ABI, connectedSigner);
        const allowance = await tokenContract.allowance(userAddress, quote.spenderAddress);

        const neededWei = BigInt(quote.fromAmountWei);
        if (allowance < neededWei) {
            onStatus({ step: 'approving', message: `Approving ${quote.fromToken.symbol} spending...` });
            const approveTx = await tokenContract.approve(quote.spenderAddress, ethers.MaxUint256);
            onStatus({ step: 'approving_pending', message: `Approval sent (${approveTx.hash}). Waiting confirmation...`, hash: approveTx.hash });
            await approveTx.wait(1);
            onStatus({ step: 'approved', message: 'Approval confirmed!' });
        }
    }

    // Broadcast transaction
    onStatus({ step: 'sending', message: `Executing ${quote.isCrossChain ? 'Cross-Chain Bridge' : 'Swap'}...` });

    const txPayload = {
        to: quote.transactionRequest.to,
        data: quote.transactionRequest.data,
        value: quote.transactionRequest.value ? BigInt(quote.transactionRequest.value) : 0n
    };

    if (quote.transactionRequest.gasLimit) {
        txPayload.gasLimit = BigInt(quote.transactionRequest.gasLimit);
    }

    const tx = await connectedSigner.sendTransaction(txPayload);
    onStatus({ step: 'sent', message: `Transaction broadcast! Hash: ${tx.hash}`, hash: tx.hash });

    const receipt = await tx.wait(1);
    onStatus({ step: 'confirmed', message: `Transaction confirmed in block ${receipt.blockNumber}!`, receipt, hash: tx.hash });

    return {
        ok: true,
        hash: tx.hash,
        blockNumber: receipt.blockNumber,
        isCrossChain: quote.isCrossChain
    };
}

/**
 * Check Cross-chain transfer status via LI.FI status API
 */
export async function checkTransferStatus(txHash, fromChainId, toChainId) {
    if (!txHash) return null;
    try {
        const url = `${LIFI_API_BASE}/status?txHash=${txHash}&fromChain=${fromChainId}&toChain=${toChainId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {}
    return null;
}
