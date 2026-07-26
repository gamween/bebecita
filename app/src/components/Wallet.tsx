import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain, type Connector } from 'wagmi'

import { CHAIN } from '../lib/client'
import { describeError } from '../lib/errors'
import { addressUrl, shortAddress } from '../lib/format'
import { addSepoliaParameter, offeredConnectors, walletConnectProjectId } from '../lib/wagmi'

/**
 * The wallet, in the top bar.
 *
 * Everything here is a wagmi hook. The account, the chain and the connector come from `useConnection`, which
 * is what makes an account switch or a chain switch inside the extension land on this page without a reload,
 * and the reconnect on load is wagmi's own, driven by the connector it remembered in storage.
 */

/**
 * Dismisses whatever is open on a press outside the wallet, or on Escape.
 *
 * The ref goes on the `.wallet` wrapper rather than on the popover, because the trigger is the popover's
 * sibling: with the ref on the popover the trigger counted as outside, so the mousedown closed the popover and
 * the click that followed reopened it, which read as a popover that refuses to close. The listeners are only
 * attached while something is open, so that a press anywhere on the page cannot quietly reset a connect error
 * the closed state is still reporting.
 */
function useOutsideClose(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!active) return
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [active, onClose])
  return ref
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), [])
  const copy = useCallback((text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => setCopied(false))
  }, [])
  return [copied, copy]
}

function ConnectorIcon({ connector }: { connector: Connector }) {
  if (!connector.icon) return <span className="connector-icon empty" aria-hidden="true" />
  return <img className="connector-icon" src={connector.icon} alt="" aria-hidden="true" />
}

function Chooser({
  connectors,
  onPick,
  pending,
  error,
}: {
  connectors: Connector[]
  onPick: (connector: Connector) => void
  pending: string | null
  error: string | null
}) {
  return (
    <div className="popover">
      <div className="popover-head">connect a wallet</div>
      <div className="popover-list">
        {connectors.map((connector) => (
          <button
            key={connector.uid}
            className="popover-item"
            onClick={() => onPick(connector)}
            disabled={pending !== null}
          >
            <ConnectorIcon connector={connector} />
            <span className="popover-item-name">{connector.name}</span>
            {pending === connector.uid ? <span className="faint">waiting</span> : null}
          </button>
        ))}
      </div>
      {error ? <div className="popover-error">{error}</div> : null}
      <div className="popover-foot">
        {walletConnectProjectId
          ? 'injected, Coinbase Wallet and WalletConnect. The taker of every fill is whatever signs here.'
          : 'WalletConnect is not offered: set VITE_WALLETCONNECT_PROJECT_ID in .env to add it.'}
      </div>
    </div>
  )
}

function Account({
  address,
  connectorName,
  onDisconnect,
}: {
  address: string
  connectorName: string
  onDisconnect: () => void
}) {
  const [copied, copy] = useCopy()
  return (
    <div className="popover">
      <div className="popover-head">
        connected through {connectorName}
        <span className="faint">Ethereum Sepolia, chainId {CHAIN.id}</span>
      </div>
      <div className="popover-address mono">{address}</div>
      <div className="popover-actions">
        <button className="btn small" onClick={() => copy(address)}>
          {copied ? 'copied' : 'copy address'}
        </button>
        <a className="btn small ghost" href={addressUrl(address)} target="_blank" rel="noreferrer">
          Etherscan
        </a>
        <button className="btn small danger" onClick={onDisconnect}>
          disconnect
        </button>
      </div>
    </div>
  )
}

export function WalletButton() {
  const { address, chainId, connector, status } = useConnection()
  const available = useConnectors()
  const { connect, isPending: connecting, error: connectError, reset: resetConnect } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain()
  const [open, setOpen] = useState<'chooser' | 'account' | null>(null)
  const [pendingConnector, setPendingConnector] = useState<string | null>(null)

  const offered = offeredConnectors(available)
  const close = useCallback(() => {
    setOpen(null)
    setPendingConnector(null)
    resetConnect()
  }, [resetConnect])
  const walletRef = useOutsideClose(open !== null, close)

  useEffect(() => {
    if (status === 'connected') {
      setPendingConnector(null)
      // A connect that failed and then succeeded some other way, in the extension or through the reconnect,
      // leaves the rejection on the mutation, and it would resurface under the connect button after a disconnect.
      resetConnect()
      setOpen((current) => (current === 'chooser' ? null : current))
      return
    }
    // Losing the account is the extension's prerogative: a disconnect or a lock done there leaves the account
    // popover describing a session that no longer exists, and it would reappear on the next connect. The chooser
    // is left alone because a rejected connect passes through here and its error is worth keeping on screen.
    setOpen((current) => (current === 'account' ? null : current))
  }, [resetConnect, status])

  const pick = useCallback(
    (chosen: Connector) => {
      setPendingConnector(chosen.uid)
      connect(
        { connector: chosen, chainId: CHAIN.id },
        {
          onSettled: () => setPendingConnector(null),
        },
      )
    },
    [connect],
  )

  const onConnectClick = useCallback(() => {
    if (open === 'chooser') {
      close()
      return
    }
    resetConnect()
    // One wallet is not a choice, so it does not get a menu.
    if (offered.length === 1) {
      pick(offered[0])
      return
    }
    setOpen('chooser')
  }, [close, offered, open, pick, resetConnect])

  if (status === 'reconnecting') {
    return (
      <span className="chip" title="wagmi is restoring the connection this browser already authorised">
        <span className="led pulse" /> restoring
      </span>
    )
  }

  if (status !== 'connected' || !address) {
    if (!offered.length) {
      return (
        <span className="chip warn" title="no extension announced itself and no other connector is configured">
          <span className="led" /> no wallet available
        </span>
      )
    }
    return (
      <div className="wallet" ref={walletRef}>
        <button
          className="btn small"
          onClick={onConnectClick}
          disabled={connecting && offered.length === 1}
          // A single wallet is connected straight away, so there is no expandable menu to report in that case.
          aria-expanded={offered.length > 1 ? open === 'chooser' : undefined}
        >
          {connecting ? 'connecting' : 'connect wallet'}
        </button>
        {open === 'chooser' ? (
          <Chooser
            connectors={offered}
            onPick={pick}
            pending={pendingConnector}
            error={connectError ? describeError(connectError) : null}
          />
        ) : null}
        {connectError && open !== 'chooser' ? (
          <div className="popover popover-quiet">
            <div className="popover-error">{describeError(connectError)}</div>
          </div>
        ) : null}
      </div>
    )
  }

  if (chainId !== CHAIN.id) {
    return (
      <div className="wallet">
        <button
          className="btn small warn"
          onClick={() => switchChain({ chainId: CHAIN.id, addEthereumChainParameter: addSepoliaParameter })}
          disabled={switching}
          title={`the wallet is on chain ${chainId}, this book only exists on Ethereum Sepolia`}
        >
          {switching ? 'switching' : `on chain ${chainId}, switch to Sepolia`}
        </button>
        {/* A wallet that cannot or will not add Sepolia would otherwise leave this bar with one dead button and
            no route back to the chooser. */}
        <button className="btn small ghost" onClick={() => disconnect()} title="disconnect and pick another wallet">
          disconnect
        </button>
        {switchError ? (
          <div className="popover popover-quiet">
            <div className="popover-error">{describeError(switchError)}</div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="wallet" ref={walletRef}>
      <button
        className="chip chip-button"
        onClick={() => (open === 'account' ? close() : setOpen('account'))}
        title={address}
        aria-expanded={open === 'account'}
      >
        <span className="led" />
        <span className="mono">{shortAddress(address)}</span>
        <span className="faint">{connector?.name ?? 'wallet'}</span>
      </button>
      {open === 'account' ? (
        <Account
          address={address}
          connectorName={connector?.name ?? 'an unnamed connector'}
          onDisconnect={() => {
            disconnect()
            close()
          }}
        />
      ) : null}
    </div>
  )
}
