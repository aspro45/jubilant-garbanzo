import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  Broadcast,
  Check,
  ClockCounterClockwise,
  Copy,
  ImageSquare,
  Lightning,
  MagnifyingGlass,
  Pause,
  Play,
  Pulse,
  Stack,
  X,
} from "@phosphor-icons/react";
import {
  formatEther,
  formatGwei,
  type Address,
  type Hash,
} from "viem";
import {
  ROBINHOOD_CHAIN_EXPLORER,
} from "./lib/chain";
import {
  fetchCollectionMetadata,
  fetchExplorerMintBatch,
  scannerClient,
  type ChainMint,
  type CollectionMetadata,
  type CollectionSample,
  type NftStandard,
} from "./lib/mintScanner";

type StandardFilter = "ALL" | NftStandard;
type SortMode = "Trending" | "Newest" | "Supply %";

type CollectionSummary = {
  address: Address;
  standard: NftStandard;
  eventCount: number;
  mintedUnits: bigint;
  minters: Set<string>;
  latestBlock: bigint;
  latestTokenId: bigint;
  latestTransactionHash: Hash;
};

const FALLBACK_IMAGE = "/assets/mint-fallback.png";

const shortAddress = (address?: string, front = 6, back = 4) =>
  address ? `${address.slice(0, front)}…${address.slice(-back)}` : "—";

const formatNumber = (value: number | bigint) =>
  new Intl.NumberFormat("en-US").format(value);

const formatCompact = (value?: bigint) => {
  if (value === undefined) return "—";
  if (value < 1_000_000n) return formatNumber(value);
  const number = Number(value);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
};

const formatMintValue = (value?: bigint) => {
  if (value === undefined) return "—";
  if (value === 0n) return "Free";
  const eth = Number(formatEther(value));
  if (eth < 0.0001) return "<0.0001 ETH";
  return `${eth.toFixed(4)} ETH`;
};

const metadataFallback = (address: Address): CollectionMetadata => ({
  address,
  name: `Collection ${address.slice(0, 6)}`,
  symbol: "NFT",
  fetchedAt: 0,
});

const supplyPercent = (metadata?: CollectionMetadata) => {
  if (!metadata?.totalSupply || !metadata.maxSupply || metadata.maxSupply <= 0n) return undefined;
  return Math.min(100, Number((metadata.totalSupply * 10_000n) / metadata.maxSupply) / 100);
};

const imageFallback = (event: SyntheticEvent<HTMLImageElement>) => {
  if (event.currentTarget.src.endsWith(FALLBACK_IMAGE)) return;
  event.currentTarget.src = FALLBACK_IMAGE;
};

function App() {
  const [mints, setMints] = useState<ChainMint[]>([]);
  const [metadata, setMetadata] = useState<Record<string, CollectionMetadata>>({});
  const [latestBlock, setLatestBlock] = useState<bigint>();
  const [gasPrice, setGasPrice] = useState<bigint>();
  const [latency, setLatency] = useState<number>();
  const [historyLimit, setHistoryLimit] = useState(150);
  const [standardFilter, setStandardFilter] = useState<StandardFilter>("ALL");
  const [sortMode, setSortMode] = useState<SortMode>("Trending");
  const [search, setSearch] = useState("");
  const [selectedCollection, setSelectedCollection] = useState<Address>();
  const [paused, setPaused] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (paused) {
      setScanning(false);
      return;
    }

    let disposed = false;
    let timer: number | undefined;
    const scan = async (initial: boolean) => {
      const startedAt = Date.now();
      setScanning(true);

      try {
        const [batch, currentGas] = await Promise.all([
          fetchExplorerMintBatch(initial ? historyLimit : 50),
          scannerClient.getGasPrice().catch(() => undefined),
        ]);

        if (!disposed) {
          setLatestBlock(batch.latestBlock);
          setGasPrice(currentGas);
          setLatency(Date.now() - startedAt);
          setError(undefined);
          setMetadata((current) => {
            const next = { ...current };
            batch.metadata.forEach((item) => {
              const key = item.address.toLowerCase();
              const previous = current[key];
              next[key] = {
                ...previous,
                ...item,
                maxSupply: previous?.maxSupply ?? item.maxSupply,
                lastMintValueWei: previous?.lastMintValueWei ?? item.lastMintValueWei,
              };
            });
            return next;
          });
          setMints((current) => {
            const base = initial ? [] : current;
            const known = new Set(base.map((event) => event.id));
            const merged = [
              ...batch.mints.filter((event) => !known.has(event.id)),
              ...base,
            ];
            return merged
              .sort((a, b) => {
                if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
                return b.logIndex - a.logIndex;
              })
              .slice(0, historyLimit);
          });
        }
      } catch (scanError) {
        if (!disposed) {
          setError(
            scanError instanceof Error
              ? scanError.message
              : "The Robinhood mainnet indexer did not answer.",
          );
        }
      } finally {
        if (!disposed) {
          setScanning(false);
          timer = window.setTimeout(() => void scan(false), 5_000);
        }
      }
    };

    void scan(true);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [paused, historyLimit, refreshKey]);

  const getMetadata = (address: Address) =>
    metadata[address.toLowerCase()] ?? metadataFallback(address);

  const searchTerm = search.trim().toLowerCase();
  const standardMints = useMemo(
    () => mints.filter((mint) => standardFilter === "ALL" || mint.standard === standardFilter),
    [mints, standardFilter],
  );

  const collectionSummaries = useMemo(() => {
    const grouped = new Map<string, CollectionSummary>();

    standardMints.forEach((mint) => {
      const meta = metadata[mint.contractAddress.toLowerCase()];
      if (
        searchTerm &&
        !mint.contractAddress.toLowerCase().includes(searchTerm) &&
        !mint.recipient.toLowerCase().includes(searchTerm) &&
        !mint.tokenId.toString().includes(searchTerm) &&
        !meta?.name.toLowerCase().includes(searchTerm) &&
        !meta?.symbol.toLowerCase().includes(searchTerm)
      ) return;

      const key = mint.contractAddress.toLowerCase();
      const existing = grouped.get(key);
      if (existing) {
        existing.eventCount += 1;
        existing.mintedUnits += mint.quantity;
        existing.minters.add(mint.recipient.toLowerCase());
        if (mint.blockNumber > existing.latestBlock) {
          existing.latestBlock = mint.blockNumber;
          existing.latestTokenId = mint.tokenId;
          existing.latestTransactionHash = mint.transactionHash;
        }
      } else {
        grouped.set(key, {
          address: mint.contractAddress,
          standard: mint.standard,
          eventCount: 1,
          mintedUnits: mint.quantity,
          minters: new Set([mint.recipient.toLowerCase()]),
          latestBlock: mint.blockNumber,
          latestTokenId: mint.tokenId,
          latestTransactionHash: mint.transactionHash,
        });
      }
    });

    return [...grouped.values()].sort((a, b) => {
      if (sortMode === "Newest") return a.latestBlock > b.latestBlock ? -1 : 1;
      if (sortMode === "Supply %") {
        const aPercent = supplyPercent(metadata[a.address.toLowerCase()]) ?? -1;
        const bPercent = supplyPercent(metadata[b.address.toLowerCase()]) ?? -1;
        return bPercent - aPercent;
      }
      return b.eventCount - a.eventCount;
    });
  }, [metadata, searchTerm, sortMode, standardMints]);

  useEffect(() => {
    if (collectionSummaries.length === 0) return;
    const exists = selectedCollection && collectionSummaries.some(
      (collection) => collection.address.toLowerCase() === selectedCollection.toLowerCase(),
    );
    if (!exists) setSelectedCollection(collectionSummaries[0].address);
  }, [collectionSummaries, selectedCollection]);

  const selectedSummary = collectionSummaries.find(
    (collection) => collection.address.toLowerCase() === selectedCollection?.toLowerCase(),
  ) ?? collectionSummaries[0];
  const selectedMeta = selectedSummary ? getMetadata(selectedSummary.address) : undefined;

  const enrichmentKey = selectedSummary
    ? `${selectedSummary.address}-${selectedSummary.latestTokenId}-${selectedSummary.latestTransactionHash}`
    : "";

  useEffect(() => {
    if (!selectedSummary || !enrichmentKey) return;
    let disposed = false;
    const sample: CollectionSample = {
      address: selectedSummary.address,
      standard: selectedSummary.standard,
      tokenId: selectedSummary.latestTokenId,
      transactionHash: selectedSummary.latestTransactionHash,
    };

    void fetchCollectionMetadata([sample]).then(([item]) => {
      if (disposed || !item) return;
      setMetadata((current) => {
        const key = item.address.toLowerCase();
        const previous = current[key];
        const itemHasFallbackName = item.name.startsWith("Collection ");
        return {
          ...current,
          [key]: {
            ...previous,
            ...item,
            name: itemHasFallbackName && previous?.name ? previous.name : item.name,
            symbol: item.symbol === "NFT" && previous?.symbol ? previous.symbol : item.symbol,
            description: item.description ?? previous?.description,
            imageUrl: item.imageUrl ?? previous?.imageUrl,
            totalSupply: item.totalSupply ?? previous?.totalSupply,
            maxSupply: item.maxSupply ?? previous?.maxSupply,
            holdersCount: item.holdersCount ?? previous?.holdersCount,
            lastMintValueWei: item.lastMintValueWei ?? previous?.lastMintValueWei,
          },
        };
      });
    }).catch(() => undefined);

    return () => { disposed = true; };
    // The key changes only when the selected contract's newest mint changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrichmentKey]);
  const selectedMints = useMemo(
    () => selectedSummary
      ? standardMints
          .filter((mint) => mint.contractAddress.toLowerCase() === selectedSummary.address.toLowerCase())
          .slice(0, 12)
      : [],
    [selectedSummary, standardMints],
  );

  const visibleFeed = useMemo(() => {
    return standardMints.filter((mint) => {
      if (!searchTerm) return true;
      const meta = metadata[mint.contractAddress.toLowerCase()];
      return [mint.contractAddress, mint.recipient, mint.tokenId.toString(), meta?.name, meta?.symbol]
        .some((value) => value?.toLowerCase().includes(searchTerm));
    }).slice(0, 40);
  }, [metadata, searchTerm, standardMints]);

  const totalMintUnits = useMemo(
    () => standardMints.reduce((total, mint) => total + mint.quantity, 0n),
    [standardMints],
  );
  const selectedPercent = supplyPercent(selectedMeta);
  const selectedImage = selectedMeta?.imageUrl ?? FALLBACK_IMAGE;
  const copyContract = async () => {
    if (!selectedSummary) return;
    await navigator.clipboard.writeText(selectedSummary.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="void-shell">
      <header className="dock">
        <a className="wordmark" href="#top" aria-label="Mintline home">Mintline</a>
        <div className="global-search">
          <MagnifyingGlass size={17} />
          <input
            ref={searchRef}
            aria-label="Search live collections"
            placeholder="Search collections, contracts…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button onClick={() => setSearch("")} aria-label="Clear search"><X size={14} /></button>
          ) : <kbd>⌘K</kbd>}
        </div>
        <div className="dock-actions">
          <button
            className={`pause-button ${paused ? "paused" : ""}`}
            onClick={() => setPaused((current) => !current)}
          >
            {paused ? <Play size={15} weight="fill" /> : <Pause size={15} weight="fill" />}
            {paused ? "Resume" : "Live scan"}
          </button>
          <span className="chain-pill"><i /> RH Mainnet</span>
          <span className="network-chip">{gasPrice ? `${Number(formatGwei(gasPrice)).toFixed(2)} gwei` : "gas —"}</span>
          <a
            className="icon-link"
            href={`${ROBINHOOD_CHAIN_EXPLORER}/txs`}
            target="_blank"
            rel="noreferrer"
            aria-label="Open Robinhood Chain explorer"
          ><ArrowSquareOut size={17} /></a>
        </div>
      </header>

      <main id="top" className="mint-workspace">
        <aside className="discover-panel surface">
          <div className="discover-head">
            <div>
              <span className="section-kicker">LIVE INDEX</span>
              <h2>Discover</h2>
            </div>
            <label>
              <span className="sr-only">Sort collections</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                <option>Trending</option>
                <option>Newest</option>
                <option>Supply %</option>
              </select>
            </label>
          </div>

          <div className="filter-stack">
            <div className="pill-row" aria-label="Token standard filter">
              {(["ALL", "ERC-721", "ERC-1155"] as StandardFilter[]).map((item) => (
                <button
                  className={standardFilter === item ? "active" : ""}
                  key={item}
                  onClick={() => setStandardFilter(item)}
                >
                  {item === "ALL" ? "All" : item.replace("ERC-", "")}
                </button>
              ))}
            </div>
            <div className="pill-row range-row" aria-label="Lookback range filter">
              {[50, 150, 300].map((item) => (
                <button
                  className={historyLimit === item ? "active" : ""}
                  key={item}
                  onClick={() => setHistoryLimit(item)}
                >
                  {item} mints
                </button>
              ))}
            </div>
          </div>

          <div className="collection-list">
            {collectionSummaries.length === 0 ? (
              <div className="panel-empty">
                <Broadcast size={28} />
                <strong>{error ? "RPC reconnecting" : "Listening for mints"}</strong>
                <span>{error ?? "Live collections will appear here."}</span>
              </div>
            ) : collectionSummaries.map((collection) => {
              const meta = getMetadata(collection.address);
              const percent = supplyPercent(meta);
              const active = selectedSummary?.address.toLowerCase() === collection.address.toLowerCase();
              return (
                <button
                  className={`mint-tile ${active ? "selected" : ""}`}
                  key={collection.address}
                  onClick={() => setSelectedCollection(collection.address)}
                  aria-pressed={active}
                >
                  <img loading="lazy" src={meta.imageUrl ?? FALLBACK_IMAGE} alt="" onError={imageFallback} />
                  <span className="tile-body">
                    <span className="tile-top">
                      <strong>{meta.name}</strong>
                      <em>{formatMintValue(meta.lastMintValueWei)}</em>
                    </span>
                    <span className="tile-meta">
                      <b>RH</b>
                      <span>{formatNumber(collection.eventCount)} mints</span>
                      <i>{latestBlock && latestBlock - collection.latestBlock <= 6n ? "LIVE" : `#${collection.latestBlock}`}</i>
                    </span>
                    <span className={`tile-progress ${percent === undefined ? "unknown" : ""}`}>
                      <i style={percent === undefined ? undefined : { width: `${percent}%` }} />
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="discover-status">
            <span><i className={error ? "bad" : ""} /> {error ? "RETRYING" : paused ? "PAUSED" : "LIVE"}</span>
            <span>{latency === undefined ? "—" : `${latency} ms`}</span>
          </div>
        </aside>

        <section className="spotlight surface">
          {selectedSummary && selectedMeta ? (
            <>
              <div className="collection-hero">
                <img className="hero-image" src={selectedImage} alt={`${selectedMeta.name} artwork`} onError={imageFallback} />
                <div className="hero-shade" />
                <div className="collection-identity">
                  <img src={selectedImage} alt="" onError={imageFallback} />
                  <div>
                    <div className="identity-title">
                      <h1>{selectedMeta.name}</h1>
                      <button onClick={copyContract} aria-label="Copy selected contract address">
                        {copied ? <Check size={15} /> : <Copy size={15} />}
                      </button>
                      <a
                        href={`${ROBINHOOD_CHAIN_EXPLORER}/address/${selectedSummary.address}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open selected contract on explorer"
                      ><ArrowSquareOut size={15} /></a>
                    </div>
                    <span className="contract-by">BY {shortAddress(selectedSummary.address, 8, 6)}</span>
                    <div className="tag-row">
                      <span className="rh-tag">RH</span>
                      <span><Stack size={13} /> {selectedSummary.standard}</span>
                      <span>{selectedMeta.maxSupply ? `${formatCompact(selectedMeta.maxSupply)} MAX` : "OPEN SUPPLY"}</span>
                      <span className="live-tag"><i /> LIVE</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="spotlight-metrics">
                <div><span>LAST TX VALUE</span><strong>{formatMintValue(selectedMeta.lastMintValueWei)}</strong></div>
                <div><span>SUPPLY</span><strong>{formatCompact(selectedMeta.totalSupply)}</strong></div>
                <div><span>HOLDERS</span><strong>{selectedMeta.holdersCount ? formatNumber(selectedMeta.holdersCount) : "—"}</strong></div>
                <div><span>RANGE MINTS</span><strong>{formatNumber(selectedSummary.eventCount)}</strong></div>
                <div><span>MINTERS</span><strong>{formatNumber(selectedSummary.minters.size)}</strong></div>
                <div><span>LATEST BLOCK</span><strong>#{selectedSummary.latestBlock}</strong></div>
              </div>

              <section className="asset-strip">
                <span><ImageSquare size={15} /> On-chain asset</span>
                <em>{selectedMeta.imageUrl ? "Metadata resolved" : "Fallback image"}</em>
              </section>

              <section className="supply-card">
                <div className="supply-copy">
                  <span>Supply progress</span>
                  {selectedMeta.totalSupply && selectedMeta.maxSupply ? (
                    <strong>{selectedPercent?.toFixed(1)}% · {formatNumber(selectedMeta.totalSupply)} / {formatNumber(selectedMeta.maxSupply)}</strong>
                  ) : (
                    <strong>{selectedMeta.totalSupply ? `${formatNumber(selectedMeta.totalSupply)} minted · max unknown` : "Supply method unavailable"}</strong>
                  )}
                </div>
                <div className={`supply-track ${selectedPercent === undefined ? "indeterminate" : ""}`}>
                  <i style={selectedPercent === undefined ? undefined : { width: `${selectedPercent}%` }} />
                </div>
              </section>

              {selectedMeta.description && <p className="collection-description">{selectedMeta.description}</p>}

              <section className="recent-card">
                <div className="card-title">
                  <h3><Lightning size={16} weight="fill" /> Recent mints</h3>
                  <span>{formatNumber(selectedMints.length)} visible</span>
                </div>
                <div className="mint-table" role="table" aria-label="Recent selected collection mints">
                  <div className="mint-row mint-head" role="row">
                    <span>Token</span><span>Minter</span><span>Qty</span><span>Tx</span><span>Block</span>
                  </div>
                  {selectedMints.map((mint) => (
                    <a
                      className="mint-row"
                      role="row"
                      href={`${ROBINHOOD_CHAIN_EXPLORER}/tx/${mint.transactionHash}`}
                      target="_blank"
                      rel="noreferrer"
                      key={mint.id}
                    >
                      <strong>#{mint.tokenId.toString()}</strong>
                      <span>{shortAddress(mint.recipient)}</span>
                      <span>{formatNumber(mint.quantity)}</span>
                      <span>{shortAddress(mint.transactionHash)}</span>
                      <span>#{mint.blockNumber}</span>
                    </a>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="spotlight-loading">
              <img src={FALLBACK_IMAGE} alt="Mintline live mint scanner" />
              <Pulse size={28} />
              <strong>{error ? "Reconnecting to mainnet" : "Reading live collections"}</strong>
              <span>{error ?? "Scanning the latest Robinhood Chain blocks."}</span>
            </div>
          )}
        </section>

        <aside className="feed-panel surface">
          <div className="feed-head">
            <div>
              <span className="section-kicker">STREAM</span>
              <h2>Live feed</h2>
            </div>
            <span className={`feed-state ${paused ? "paused" : ""}`}><i /> {paused ? "PAUSED" : "LIVE"}</span>
          </div>
          <div className="feed-stats">
            <div><span>EVENTS</span><strong>{formatNumber(standardMints.length)}</strong></div>
            <div><span>NFT UNITS</span><strong>{formatCompact(totalMintUnits)}</strong></div>
          </div>
          <div className="feed-list" aria-live="polite">
            {visibleFeed.length === 0 ? (
              <div className="panel-empty">
                <Broadcast size={28} />
                <strong>Listening for mints</strong>
                <span>New mainnet events will appear here.</span>
              </div>
            ) : visibleFeed.map((mint) => {
              const meta = getMetadata(mint.contractAddress);
              return (
                <a
                  className="feed-item"
                  href={`${ROBINHOOD_CHAIN_EXPLORER}/tx/${mint.transactionHash}`}
                  target="_blank"
                  rel="noreferrer"
                  key={mint.id}
                >
                  <img loading="lazy" src={meta.imageUrl ?? FALLBACK_IMAGE} alt="" onError={imageFallback} />
                  <span>
                    <strong>{meta.name}</strong>
                    <em>Token #{mint.tokenId.toString()} · {formatMintValue(meta.lastMintValueWei)}</em>
                    <small>{shortAddress(mint.recipient)} · #{mint.blockNumber}</small>
                  </span>
                  <ArrowSquareOut size={13} />
                </a>
              );
            })}
          </div>
          <div className="feed-footer">
            <ClockCounterClockwise size={14} /> {historyLimit} event buffer
            <button onClick={() => setRefreshKey((current) => current + 1)} aria-label="Rescan live mint buffer">
              <ArrowsClockwise size={14} />
            </button>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
