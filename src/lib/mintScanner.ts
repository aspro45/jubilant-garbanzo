import {
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  zeroAddress,
  type Address,
  type Hash,
} from "viem";
import { ROBINHOOD_CHAIN_EXPLORER, robinhoodChain } from "./chain";

export type NftStandard = "ERC-721" | "ERC-1155";

export type ChainMint = {
  id: string;
  standard: NftStandard;
  contractAddress: Address;
  recipient: Address;
  tokenId: bigint;
  quantity: bigint;
  blockNumber: bigint;
  transactionHash: Hash;
  logIndex: number;
  seenAt: number;
};

export type CollectionSample = {
  address: Address;
  standard: NftStandard;
  tokenId: bigint;
  transactionHash: Hash;
};

export type CollectionMetadata = {
  address: Address;
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  totalSupply?: bigint;
  maxSupply?: bigint;
  holdersCount?: number;
  lastMintValueWei?: bigint;
  fetchedAt: number;
};

export type ExplorerMintBatch = {
  mints: ChainMint[];
  metadata: CollectionMetadata[];
  latestBlock?: bigint;
};

export const scannerClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(undefined, {
    retryCount: 2,
    timeout: 12_000,
  }),
  pollingInterval: 2_500,
});

const erc721Transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const erc1155Single = parseAbiItem(
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
);

const erc1155Batch = parseAbiItem(
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
);

const collectionAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function collectionSize() view returns (uint256)",
  "function maxTokenSupply() view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function contractURI() view returns (string)",
]);

const erc1155MetadataAbi = parseAbi([
  "function uri(uint256 tokenId) view returns (string)",
  "function totalSupply(uint256 tokenId) view returns (uint256)",
]);

const metadataCache = new Map<string, CollectionMetadata>();
const CACHE_TTL = 45_000;

const cleanLabel = (value: string, fallback: string, max = 54) => {
  const cleaned = value.replace(/[\u0000-\u001f]/g, "").trim();
  return (cleaned || fallback).slice(0, max);
};

const replaceErc1155Id = (value: string, tokenId: bigint) => {
  if (!value.includes("{id}")) return value;
  return value.replaceAll("{id}", tokenId.toString(16).padStart(64, "0"));
};

export const normalizeAssetUrl = (value?: string, tokenId = 0n) => {
  if (!value) return undefined;
  const url = replaceErc1155Id(value.trim(), tokenId);
  if (url.startsWith("ipfs://ipfs/")) return `https://ipfs.io/ipfs/${url.slice(12)}`;
  if (url.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${url.slice(7)}`;
  if (url.startsWith("ar://")) return `https://arweave.net/${url.slice(5)}`;
  if (/^https?:\/\//i.test(url) || /^data:image\//i.test(url)) return url;
  return undefined;
};

type TokenJson = {
  name?: unknown;
  description?: unknown;
  image?: unknown;
  image_url?: unknown;
  image_data?: unknown;
};

const parseDataJson = (uri: string): TokenJson | undefined => {
  try {
    const comma = uri.indexOf(",");
    if (comma < 0) return undefined;
    const header = uri.slice(0, comma);
    const payload = uri.slice(comma + 1);
    const text = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
    return JSON.parse(text) as TokenJson;
  } catch {
    return undefined;
  }
};

const fetchJsonUri = async (uri?: string, tokenId = 0n): Promise<TokenJson | undefined> => {
  if (!uri) return undefined;
  if (uri.startsWith("data:application/json")) return parseDataJson(uri);
  const target = normalizeAssetUrl(uri, tokenId);
  if (!target || target.startsWith("data:image/")) return undefined;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 7_000);
  try {
    const response = await fetch(target, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json() as TokenJson;
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
};

const imageFromJson = (json: TokenJson | undefined, tokenId: bigint) => {
  if (!json) return undefined;
  const image = typeof json.image === "string"
    ? json.image
    : typeof json.image_url === "string" ? json.image_url : undefined;
  const normalized = normalizeAssetUrl(image, tokenId);
  if (normalized) return normalized;
  if (typeof json.image_data === "string" && json.image_data.trim().startsWith("<svg")) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(json.image_data)}`;
  }
  return undefined;
};

type ExplorerToken = {
  holders_count?: string;
  icon_url?: string | null;
  total_supply?: string | null;
};

type ExplorerTransfer = {
  block_number?: number | string;
  log_index?: number | string;
  timestamp?: string;
  transaction_hash?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  token?: {
    address_hash?: string;
    name?: string | null;
    symbol?: string | null;
    type?: string;
    holders_count?: number | string;
    total_supply?: string | null;
    icon_url?: string | null;
  };
  total?: {
    token_id?: string | null;
    value?: string | null;
    token_instance?: {
      image_url?: string | null;
      media_url?: string | null;
      metadata?: TokenJson | null;
    } | null;
  };
};

type ExplorerTransfersResponse = {
  items?: ExplorerTransfer[];
  next_page_params?: Record<string, string | number | boolean | null> | null;
};

const safeBigInt = (value: unknown, fallback = 0n) => {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    // Malformed explorer values should not stop the live feed.
  }
  return fallback;
};

const safeAddress = (value?: string) =>
  value && /^0x[a-fA-F0-9]{40}$/.test(value) ? value as Address : undefined;

const safeHash = (value?: string) =>
  value && /^0x[a-fA-F0-9]{64}$/.test(value) ? value as Hash : undefined;

const explorerImage = (transfer: ExplorerTransfer, tokenId: bigint) => {
  const instance = transfer.total?.token_instance;
  return normalizeAssetUrl(instance?.image_url ?? undefined, tokenId)
    ?? normalizeAssetUrl(instance?.media_url ?? undefined, tokenId)
    ?? imageFromJson(instance?.metadata ?? undefined, tokenId)
    ?? normalizeAssetUrl(transfer.token?.icon_url ?? undefined, tokenId);
};

export async function fetchExplorerMintBatch(limit = 150): Promise<ExplorerMintBatch> {
  const target = Math.min(Math.max(limit, 25), 300);
  const maxPages = Math.min(6, Math.max(1, Math.ceil(target / 45)));
  const mints: ChainMint[] = [];
  const metadataByAddress = new Map<string, CollectionMetadata>();
  let pageUrl = `${ROBINHOOD_CHAIN_EXPLORER}/api/v2/token-transfers?type=ERC-721%2CERC-1155`;
  let latestBlock: bigint | undefined;

  for (let page = 0; page < maxPages && pageUrl && mints.length < target; page += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    let payload: ExplorerTransfersResponse;

    try {
      const response = await fetch(pageUrl, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Explorer API returned ${response.status}.`);
      payload = await response.json() as ExplorerTransfersResponse;
    } finally {
      window.clearTimeout(timer);
    }

    for (const transfer of payload.items ?? []) {
      if (transfer.from?.hash?.toLowerCase() !== zeroAddress) continue;

      const contractAddress = safeAddress(transfer.token?.address_hash);
      const recipient = safeAddress(transfer.to?.hash);
      const transactionHash = safeHash(transfer.transaction_hash);
      if (!contractAddress || !recipient || !transactionHash) continue;

      const standard: NftStandard = transfer.token?.type === "ERC-1155" ? "ERC-1155" : "ERC-721";
      const tokenId = safeBigInt(transfer.total?.token_id);
      const blockNumber = safeBigInt(transfer.block_number);
      const logIndex = Number(transfer.log_index ?? 0) || 0;
      const quantity = standard === "ERC-1155"
        ? safeBigInt(transfer.total?.value, 1n)
        : 1n;
      const timestamp = transfer.timestamp ? Date.parse(transfer.timestamp) : NaN;

      mints.push({
        id: `${transactionHash}-${logIndex}-${tokenId}`,
        standard,
        contractAddress,
        recipient,
        tokenId,
        quantity,
        blockNumber,
        transactionHash,
        logIndex,
        seenAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });

      if (latestBlock === undefined || blockNumber > latestBlock) latestBlock = blockNumber;

      const key = contractAddress.toLowerCase();
      const existing = metadataByAddress.get(key);
      const json = transfer.total?.token_instance?.metadata ?? undefined;
      const totalSupply = positive(safeBigInt(transfer.token?.total_supply));
      const holders = Number(transfer.token?.holders_count);
      const next: CollectionMetadata = {
        address: contractAddress,
        name: cleanLabel(transfer.token?.name ?? "", `Collection ${contractAddress.slice(0, 6)}`),
        symbol: cleanLabel(transfer.token?.symbol ?? "", "NFT", 18),
        description: typeof json?.description === "string"
          ? cleanLabel(json.description, "", 180)
          : existing?.description,
        imageUrl: explorerImage(transfer, tokenId) ?? existing?.imageUrl,
        totalSupply: totalSupply ?? existing?.totalSupply,
        holdersCount: Number.isFinite(holders) && holders > 0 ? holders : existing?.holdersCount,
        fetchedAt: Date.now(),
      };
      metadataByAddress.set(key, next);
    }

    const nextParams = payload.next_page_params;
    if (!nextParams) break;
    const nextUrl = new URL(`${ROBINHOOD_CHAIN_EXPLORER}/api/v2/token-transfers`);
    nextUrl.searchParams.set("type", "ERC-721,ERC-1155");
    Object.entries(nextParams).forEach(([key, value]) => {
      if (value !== null && value !== undefined) nextUrl.searchParams.set(key, String(value));
    });
    pageUrl = nextUrl.toString();
  }

  const unique = new Map<string, ChainMint>();
  mints.forEach((mint) => unique.set(mint.id, mint));
  const ordered = [...unique.values()].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
    return b.logIndex - a.logIndex;
  }).slice(0, target);

  return {
    mints: ordered,
    metadata: [...metadataByAddress.values()],
    latestBlock,
  };
}

const fetchExplorerToken = async (address: Address): Promise<ExplorerToken | undefined> => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${ROBINHOOD_CHAIN_EXPLORER}/api/v2/tokens/${address}`, {
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return await response.json() as ExplorerToken;
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
};

const positive = (value?: bigint) => value && value > 0n ? value : undefined;

async function readCollectionMetadata(sample: CollectionSample): Promise<CollectionMetadata> {
  const key = sample.address.toLowerCase();
  const cached = metadataCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  const [contractResults, transaction, explorerToken] = await Promise.all([
    scannerClient.multicall({
      allowFailure: true,
      contracts: [
        { address: sample.address, abi: collectionAbi, functionName: "name" },
        { address: sample.address, abi: collectionAbi, functionName: "symbol" },
        { address: sample.address, abi: collectionAbi, functionName: "totalSupply" },
        { address: sample.address, abi: collectionAbi, functionName: "maxSupply" },
        { address: sample.address, abi: collectionAbi, functionName: "MAX_SUPPLY" },
        { address: sample.address, abi: collectionAbi, functionName: "collectionSize" },
        { address: sample.address, abi: collectionAbi, functionName: "maxTokenSupply" },
        { address: sample.address, abi: collectionAbi, functionName: "tokenURI", args: [sample.tokenId] },
        { address: sample.address, abi: erc1155MetadataAbi, functionName: "uri", args: [sample.tokenId] },
        { address: sample.address, abi: erc1155MetadataAbi, functionName: "totalSupply", args: [sample.tokenId] },
        { address: sample.address, abi: collectionAbi, functionName: "contractURI" },
      ],
    }).catch(() => []),
    scannerClient.getTransaction({ hash: sample.transactionHash }).catch(() => undefined),
    fetchExplorerToken(sample.address),
  ]);

  const valueAt = (index: number) => {
    const result = contractResults[index];
    return result?.status === "success" ? result.result : undefined;
  };
  const name = valueAt(0) as string | undefined;
  const symbol = valueAt(1) as string | undefined;
  const totalSupplyResult = valueAt(2) as bigint | undefined;
  const maxSupply = valueAt(3) as bigint | undefined;
  const maxSupplyUpper = valueAt(4) as bigint | undefined;
  const collectionSize = valueAt(5) as bigint | undefined;
  const maxTokenSupply = valueAt(6) as bigint | undefined;
  const tokenUri721 = valueAt(7) as string | undefined;
  const tokenUri1155 = valueAt(8) as string | undefined;
  const supply1155 = valueAt(9) as bigint | undefined;
  const contractUri = valueAt(10) as string | undefined;

  const tokenJson = await fetchJsonUri(tokenUri721 ?? tokenUri1155, sample.tokenId);
  const contractJson = tokenJson ? undefined : await fetchJsonUri(contractUri, sample.tokenId);
  const json = tokenJson ?? contractJson;
  const explorerSupply = explorerToken?.total_supply && /^\d+$/.test(explorerToken.total_supply)
    ? BigInt(explorerToken.total_supply)
    : undefined;
  const totalSupply = positive(totalSupplyResult) ?? positive(supply1155) ?? positive(explorerSupply);
  const max = [maxSupply, maxSupplyUpper, collectionSize, maxTokenSupply]
    .map(positive)
    .find((value) => value !== undefined && (!totalSupply || value >= totalSupply));
  const fallback = `Collection ${sample.address.slice(0, 6)}`;

  const metadata: CollectionMetadata = {
    address: sample.address,
    name: cleanLabel(
      name ?? (typeof json?.name === "string" ? json.name : ""),
      fallback,
    ),
    symbol: cleanLabel(symbol ?? "", "NFT", 18),
    description: typeof json?.description === "string"
      ? cleanLabel(json.description, "", 180)
      : undefined,
    imageUrl: imageFromJson(json, sample.tokenId) ?? normalizeAssetUrl(explorerToken?.icon_url ?? undefined),
    totalSupply,
    maxSupply: max,
    holdersCount: explorerToken?.holders_count && /^\d+$/.test(explorerToken.holders_count)
      ? Number(explorerToken.holders_count)
      : undefined,
    lastMintValueWei: transaction?.value,
    fetchedAt: Date.now(),
  };

  metadataCache.set(key, metadata);
  return metadata;
}

export async function fetchGlobalMints(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ChainMint[]> {
  const seenAt = Date.now();
  const results = await Promise.allSettled([
    scannerClient.getLogs({
      event: erc721Transfer,
      args: { from: zeroAddress },
      fromBlock,
      toBlock,
    }),
    scannerClient.getLogs({
      event: erc1155Single,
      args: { from: zeroAddress },
      fromBlock,
      toBlock,
    }),
    scannerClient.getLogs({
      event: erc1155Batch,
      args: { from: zeroAddress },
      fromBlock,
      toBlock,
    }),
  ]);

  if (results.every((result) => result.status === "rejected")) {
    throw new Error("The public RPC rejected every mint-log query.");
  }

  const mints: ChainMint[] = [];
  const [erc721Result, singleResult, batchResult] = results;

  if (erc721Result.status === "fulfilled") {
    for (const log of erc721Result.value) {
      if (
        !log.transactionHash ||
        log.blockNumber === null ||
        log.args.to === undefined ||
        log.args.tokenId === undefined
      ) continue;

      mints.push({
        id: `${log.transactionHash}-${log.logIndex ?? 0}-721`,
        standard: "ERC-721",
        contractAddress: log.address,
        recipient: log.args.to,
        tokenId: log.args.tokenId,
        quantity: 1n,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex ?? 0,
        seenAt,
      });
    }
  }

  if (singleResult.status === "fulfilled") {
    for (const log of singleResult.value) {
      if (
        !log.transactionHash ||
        log.blockNumber === null ||
        log.args.to === undefined ||
        log.args.id === undefined ||
        log.args.value === undefined
      ) continue;

      mints.push({
        id: `${log.transactionHash}-${log.logIndex ?? 0}-1155-single`,
        standard: "ERC-1155",
        contractAddress: log.address,
        recipient: log.args.to,
        tokenId: log.args.id,
        quantity: log.args.value,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex ?? 0,
        seenAt,
      });
    }
  }

  if (batchResult.status === "fulfilled") {
    for (const log of batchResult.value) {
      if (
        !log.transactionHash ||
        log.blockNumber === null ||
        log.args.to === undefined ||
        !log.args.ids ||
        !log.args.values
      ) continue;

      log.args.ids.forEach((tokenId, index) => {
        mints.push({
          id: `${log.transactionHash}-${log.logIndex ?? 0}-1155-${index}`,
          standard: "ERC-1155",
          contractAddress: log.address,
          recipient: log.args.to!,
          tokenId,
          quantity: log.args.values?.[index] ?? 1n,
          blockNumber: log.blockNumber!,
          transactionHash: log.transactionHash!,
          logIndex: log.logIndex ?? 0,
          seenAt,
        });
      });
    }
  }

  return mints.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
    return b.logIndex - a.logIndex;
  });
}

export async function fetchCollectionMetadata(
  samples: CollectionSample[],
): Promise<CollectionMetadata[]> {
  const seen = new Set<string>();
  const unique = samples.filter((sample) => {
    const key = sample.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 16);

  const result: CollectionMetadata[] = [];
  for (let index = 0; index < unique.length; index += 4) {
    result.push(...await Promise.all(unique.slice(index, index + 4).map(readCollectionMetadata)));
  }
  return result;
}
