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

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
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
  }, [onClose])
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
  onClose,
  pending,
  error,
}: {
  connectors: Connector[]
  onPick: (connector: Connector) => void
  onClose: () => void
  pending: string | null
  error: string | null
}) {
  const ref = useOutsideClose(onClose)
  return (
    <div className="popover" ref={ref}>
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
  onClose,
}: {
  address: string
  connectorName: string
  onDisconnect: () => void
  onClose: () => void
}) {
  const ref = useOutsideClose(onClose)
  const [copied, copy] = useCopy()
  return (
    <div className="popover" ref={ref}>
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

  useEffect(() => {
    if (status === 'connected') {
      setPendingConnector(null)
      setOpen((current) => (current === 'chooser' ? null : current))
    }
  }, [status])

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
      <div className="wallet">
        <button className="btn small" onClick={onConnectClick} disabled={connecting && offered.length === 1}>
          {connecting ? 'connecting' : 'connect wallet'}
        </button>
        {open === 'chooser' ? (
          <Chooser
            connectors={offered}
            onPick={pick}
            onClose={close}
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
        {switchError ? (
          <div className="popover popover-quiet">
            <div className="popover-error">{describeError(switchError)}</div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="wallet">
      <button
        className="chip chip-button"
        onClick={() => setOpen(open === 'account' ? null : 'account')}
        title={address}
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
          onClose={close}
        />
      ) : null}
    </div>
  )
}
