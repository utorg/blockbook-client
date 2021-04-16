import { BlockHashResponseWs } from './types/common';
import request from 'request-promise-native'
import { assertType, DelegateLogger, isMatchingError, isString, Logger } from '@faast/ts-common'
import * as t from 'io-ts'
import WebSocket from 'ws'

import {
  XpubDetailsBasic, XpubDetailsTokens, XpubDetailsTokenBalances, XpubDetailsTxids, XpubDetailsTxs,
  BlockbookConfig, SystemInfo, BlockHashResponse, GetAddressDetailsOptions,
  UtxoDetails, UtxoDetailsXpub, GetUtxosOptions, GetXpubDetailsOptions,
  SendTxSuccess, SendTxError,
  Resolve, Reject, SystemInfoWs
} from './types'
import { jsonRequest, USER_AGENT } from './utils'

const xpubDetailsCodecs = {
  basic: XpubDetailsBasic,
  tokens: XpubDetailsTokens,
  tokenBalances: XpubDetailsTokenBalances,
  txids: XpubDetailsTxids,
  txs: XpubDetailsTxs,
}

/**
 * Blockbook client with support for both http and ws with multi-node and type validation support.
 *
 * Reference websocket implementation based on:
 * https://github.com/trezor/blockbook/blob/master/static/test-websocket.html
 */
export abstract class BaseBlockbook<
  NormalizedTx,
  SpecificTx,
  BlockInfo,
  AddressDetailsBasic,
  AddressDetailsTokens,
  AddressDetailsTokenBalances,
  AddressDetailsTxids,
  AddressDetailsTxs,
> {
  nodes: string[]
  disableTypeValidation: boolean
  requestTimeoutMs: number
  ws: WebSocket
  wsConnected: boolean
  logger: Logger

  private requestCounter = 0
  private pingIntervalId: NodeJS.Timeout
  private pendingWsRequests: { [id: string]: { resolve: Resolve, reject: Reject } } = {}
  private subscriptions: { [id: string]: { callback: Resolve, method: string } } = {}
  private subscribeNewBlockId = ''
  private subscribeNewTransactionId = ''
  private subscribeAddressesId = ''

  constructor(
    config: BlockbookConfig,
    private normalizedTxCodec: t.Type<NormalizedTx>,
    private specificTxCodec: t.Type<SpecificTx>,
    private blockInfoCodec: t.Type<BlockInfo>,
    private addressDetailsCodecs: {
      basic: t.Type<AddressDetailsBasic>,
      tokens: t.Type<AddressDetailsTokens>,
      tokenBalances: t.Type<AddressDetailsTokenBalances>,
      txids: t.Type<AddressDetailsTxids>,
      txs: t.Type<AddressDetailsTxs>,
    }
  ) {
    config = assertType(BlockbookConfig, config)
    if (config.nodes.length === 0) {
      throw new Error('Blockbook node list must not be empty')
    }
    // trim trailing slash
    this.nodes = config.nodes.map((node) => node.trim().replace(/\/$/, ''))

    // validate all responses by default
    this.disableTypeValidation = config.disableTypeValidation || false

    // fail fast by default
    this.requestTimeoutMs = config.requestTimeoutMs || 5000

    // prefix all log messages with package name
    this.logger = new DelegateLogger(config.logger, 'blockbook-client')
  }

  doAssertType<T>(codec: t.Type<T, any, unknown>, value: unknown, ...rest: any[]): T {
    if (this.disableTypeValidation) {
      return value as T
    }
    return assertType(codec, value, ...rest)
  }


  /** Load balance using round robin. Helps any retry logic fallback to different nodes */
  private getNode() {
    return this.nodes[this.requestCounter++ % this.nodes.length]
  }

  async httpRequest(
    method: 'GET' | 'POST', path: string, params?: object, body?: object, options?: Partial<request.Options>,
  ) {
    return jsonRequest(this.getNode(), method, path, params, body, { timeout: this.requestTimeoutMs, ...options })
  }

  wsRequest(method: string, params?: object, idOption?: string): Promise<any> {
    const id = idOption ?? (this.requestCounter++).toString()
    const req = {
        id,
        method,
        params
    }
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        delete this.pendingWsRequests[id]
        reject(`Timeout waiting for websocket ${method} response (id: ${id})`)
      }, this.requestTimeoutMs)
      this.pendingWsRequests[id] = { resolve, reject }
      this.ws.send(JSON.stringify(req))
    })
  }

  subscribe(method: string, params: object, callback: (result: any) => void) {
    const id = (this.requestCounter++).toString()
    this.subscriptions[id] = { callback, method }
    return [id, this.wsRequest(method, params)]
  }

  unsubscribe(method: string, params: object, id: string) {
    delete this.subscriptions[id]
    return this.wsRequest(method, params)
  }

  async connect(): Promise<void> {
    if (this.wsConnected) {
      return
    }
    this.pendingWsRequests = {}
    this.subscriptions = {}
    this.subscribeNewBlockId = ''
    this.subscribeNewTransactionId = ''
    this.subscribeAddressesId = ''
    let node = this.getNode()
    if (node.startsWith('http')) {
      node = node.replace('http', 'ws')
    }
    if (!node.startsWith('ws')) {
      node = `wss://${node}`
    }
    if (!node.endsWith('/websocket')) {
      node += '/websocket'
    }

    // Wait for the connection before resolving
    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(node, { headers: { 'user-agent': USER_AGENT } })
      this.ws.once('open', (e) => {
        this.logger.log('socket connected', e)
        this.wsConnected = true
        resolve()
      })
      this.ws.once('error', (e) => {
        this.logger.warn('socket connect error', e)
        this.ws.close()
        reject(e)
      })
    })

    this.ws.on('close', (e) => {
      this.logger.warn('socket closed', e)
      this.wsConnected = false
      clearInterval(this.pingIntervalId)
    })
    this.ws.on('error', (e) => {
      this.logger.warn('socket error ', e)
      this.wsConnected = false
      this.ws.close()
    })

    // Parse all incoming messages and forward them to any pending requests or subscriptions
    this.ws.on('message', (data) => {
      this.logger.debug('socket message', data)
      if (!isString(data)) {
        this.logger.error(`Unrecognized websocket data type ${typeof data} received from ${node}`)
        return
      }
      let response
      try {
        response = JSON.parse(data)
      } catch (e) {
        this.logger.error(`Failed to parse websocket data received from ${node}`, e.toString())
        return
      }
      const id = response.id
      if (!isString(id)) {
        this.logger.error(`Received websocket data without a valid ID from ${node}`, response)
      }
      const result = response.data
      let errorMessage: string = ''
      if (result?.error) {
        errorMessage = result.error.message ?? data
      }
      const pendingRequest = this.pendingWsRequests[id]
      if (pendingRequest) {
          delete this.pendingWsRequests[id]
          if (errorMessage) {
            return pendingRequest.reject(new Error(errorMessage))
          }
          return pendingRequest.resolve(result)
      }
      const activeSubscription = this.subscriptions[id]
      if (activeSubscription) {
        if (errorMessage) {
          this.logger.error(
            `Received error response for ${activeSubscription.method} subscription from ${node}`,
            errorMessage,
          )
        }
        return activeSubscription.callback(result)
      }
      this.logger.warn(`Unrecognized websocket data (id: ${id}) received from ${node}`, result)
    })

    // Periodically ping the server and disconnect when unresponsive
    this.pingIntervalId = setInterval(async () => {
      try {
        await this.wsRequest('ping', {})
      } catch (e) {
        this.ws.terminate() // force close
      }
    }, 25000)
  }

  /* Close the websocket or do nothing if not connected */
  async disconnect(): Promise<void> {
    if (!this.wsConnected) {
      return
    }
    return new Promise((resolve, reject) => {
      this.ws.once('close', () => resolve())
      this.ws.once('error', (e) => reject(e))
      this.ws.close()
    })
  }

  // ws getInfo
  async getInfo(): Promise<SystemInfoWs> {
    if (!this.wsConnected) {
      throw new Error('Websocket must be connected to call getInfo')
    }
    const response = await this.wsRequest('getInfo')
    return this.doAssertType(SystemInfoWs, response)
  }

  async getStatus(): Promise<SystemInfo> {
    const response = await this.httpRequest('GET', '/api/v2')
    return this.doAssertType(SystemInfo, response)
  }

  async getBlockHash(blockNumber: number): Promise<string> {
    if (this.wsConnected) {
      const response = await this.wsRequest('getBlockHash', { height: blockNumber })
      const { hash } = this.doAssertType(BlockHashResponseWs, response)
      return hash
    }
    const response = await this.httpRequest('GET', `/api/v2/block-index/${blockNumber}`)
    const { blockHash } = this.doAssertType(BlockHashResponse, response)
    return blockHash
  }

  async getTx(txid: string): Promise<NormalizedTx> {
    const response = this.wsConnected
      ? await this.wsRequest('getTransaction', { txid })
      : await this.httpRequest('GET', `/api/v2/tx/${txid}`)
    return this.doAssertType(this.normalizedTxCodec, response)
  }

  async getTxSpecific(txid: string): Promise<SpecificTx> {
    const response = this.wsConnected
      ? await this.wsRequest('getTransactionSpecific', { txid })
      : await this.httpRequest('GET', `/api/v2/tx-specific/${txid}`)
    return this.doAssertType(this.specificTxCodec, response)
  }

  async getAddressDetails(
    address: string,
    options: GetAddressDetailsOptions & { details: 'basic' },
  ): Promise<AddressDetailsBasic>
  async getAddressDetails(
    address: string,
    options: GetAddressDetailsOptions & { details: 'tokens' },
  ): Promise<AddressDetailsTokens>
  async getAddressDetails(
    address: string,
    options: GetAddressDetailsOptions & { details: 'tokenBalances' }
  ): Promise<AddressDetailsTokenBalances>
  async getAddressDetails(
    address: string,
    options?: GetAddressDetailsOptions & { details: 'txids' | undefined } | Omit<GetAddressDetailsOptions, 'details'>
  ): Promise<AddressDetailsTxids>
  async getAddressDetails(
    address: string,
    options: GetAddressDetailsOptions & { details: 'txs' },
  ): Promise<AddressDetailsTxs>
  async getAddressDetails(address: string, options: GetAddressDetailsOptions = {}) {
    const detailsLevel = options.details || 'txids'
    const response = this.wsConnected
      ? await this.wsRequest('getAccountInfo', { descriptor: address, ...options, details: detailsLevel })
      : await this.httpRequest('GET', `/api/v2/address/${address}`, { ...options, details: detailsLevel })
    const codec: t.Mixed = this.addressDetailsCodecs[detailsLevel]
    return this.doAssertType(codec, response)
  }

  async getXpubDetails(
    xpub: string,
    options: GetXpubDetailsOptions & { details: 'basic' },
  ): Promise<XpubDetailsBasic>
  async getXpubDetails(
    xpub: string,
    options: GetXpubDetailsOptions & { details: 'tokens' },
  ): Promise<XpubDetailsTokens>
  async getXpubDetails(
    xpub: string,
    options: GetXpubDetailsOptions & { details: 'tokenBalances' }
  ): Promise<XpubDetailsTokenBalances>
  async getXpubDetails(
    xpub: string,
    options?: GetXpubDetailsOptions & { details: 'txids' | undefined } | Omit<GetXpubDetailsOptions, 'details'>
  ): Promise<XpubDetailsTxids>
  async getXpubDetails(
    xpub: string,
    options: GetXpubDetailsOptions & { details: 'txs' },
  ): Promise<XpubDetailsTxs>
  async getXpubDetails(xpub: string, options: GetXpubDetailsOptions = {}) {
    const tokens = options.tokens || 'derived'
    const detailsLevel = options.details || 'txids'
    const response = this.wsConnected
      ? await this.wsRequest('getAccountInfo', { descriptor: xpub, details: detailsLevel, tokens, ...options })
      : await this.httpRequest('GET', `/api/v2/xpub/${xpub}`, { details: detailsLevel, tokens, ...options })
    const codec: t.Mixed = xpubDetailsCodecs[detailsLevel]
    return this.doAssertType(codec, response)
  }

  async getUtxosForAddress(address: string, options: GetUtxosOptions = {}): Promise<UtxoDetails[]> {
    const response = this.wsConnected
      ? await this.wsRequest('getAccountUtxo', { descriptor: address, ...options })
      : await this.httpRequest('GET', `/api/v2/utxo/${address}`, options)
    return this.doAssertType(t.array(UtxoDetails), response)
  }

  async getUtxosForXpub(xpub: string, options: GetUtxosOptions = {}): Promise<UtxoDetailsXpub[]> {
    const response = this.wsConnected
      ? await this.wsRequest('getAccountUtxo', { descriptor: xpub, ...options })
      : await this.httpRequest('GET', `/api/v2/utxo/${xpub}`, options)
    return this.doAssertType(t.array(UtxoDetailsXpub), response)
  }

  async getBlock(block: string | number): Promise<BlockInfo> {
    // http only
    const response = await this.httpRequest('GET', `/api/v2/block/${block}`)
    return this.doAssertType(this.blockInfoCodec, response)
  }

  async sendTx(txHex: string): Promise<string> {
    // NOTE: sendtx POST doesn't work without trailing slash, and sendtx GET fails for large txs
    const response = this.wsConnected
      ? await this.wsRequest('sendTransaction', { hex: txHex })
      : await this.httpRequest('POST', '/api/v2/sendtx/', undefined, undefined, { body: txHex, json: false })

    const { result: txHash } = this.doAssertType(SendTxSuccess, response)
    return txHash
  }
}
