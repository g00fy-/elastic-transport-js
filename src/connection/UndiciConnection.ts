/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { EventEmitter } from 'events'
import Debug from 'debug'
import buffer from 'buffer'
import BaseConnection, {
  ConnectionOptions,
  ConnectionRequestParams,
  ConnectionRequestOptions,
  ConnectionRequestResponse
} from './BaseConnection'
import { Pool } from 'undici'
import {
  ConfigurationError,
  RequestAbortedError,
  ConnectionError,
  TimeoutError
} from '../errors'
import { TlsOptions } from 'tls'
import { UndiciAgentOptions } from '../types'
import { kEmitter } from '../symbols'

const debug = Debug('elasticsearch')
const INVALID_PATH_REGEX = /[^\u0021-\u00ff]/
const MAX_BUFFER_LENGTH = buffer.constants.MAX_LENGTH
const MAX_STRING_LENGTH = buffer.constants.MAX_STRING_LENGTH

export default class Connection extends BaseConnection {
  pool: Pool
  [kEmitter]: EventEmitter

  constructor (opts: ConnectionOptions) {
    super(opts)

    if (opts.proxy != null) {
      throw new ConfigurationError('Undici connection can\'t work with proxies')
    }

    if (typeof opts.agent === 'function' || typeof opts.agent === 'boolean') {
      throw new ConfigurationError('Undici connection agent options can\'t be a function or a boolean')
    }

    if (opts.agent != null && !isUndiciAgentOptions(opts.agent)) {
      throw new ConfigurationError('Bad agent configuration for Undici agent')
    }

    this[kEmitter] = new EventEmitter()
    this.pool = new Pool(this.url.toString(), {
      tls: this.ssl as TlsOptions,
      keepAliveTimeout: 4000,
      keepAliveMaxTimeout: 600e3,
      keepAliveTimeoutThreshold: 1000,
      pipelining: 1,
      maxHeaderSize: 16384,
      connections: 256,
      headersTimeout: this.timeout,
      // @ts-expect-error
      bodyTimeout: this.timeout,
      ...opts.agent
    })
  }

  async request (params: ConnectionRequestParams, options: ConnectionRequestOptions): Promise<ConnectionRequestResponse> {
    const requestParams = {
      method: params.method,
      path: params.path + (params.querystring == null || params.querystring === '' ? '' : `?${params.querystring}`),
      headers: Object.assign({}, this.headers, params.headers),
      body: params.body,
      signal: params.abortController?.signal ?? this[kEmitter]
    }

    // undici does not support per-request timeouts,
    // to address this issue, we default to the constructor
    // timeout (which is handled by undici) and create a local
    // setTimeout callback if the request-specific timeout
    // is different from the constructor timeout.
    let timedout = false
    let timeoutId
    if (params.timeout != null && params.timeout !== this.timeout) {
      timeoutId = setTimeout(() => {
        timedout = true
        if (params.abortController?.signal != null) {
          params.abortController.abort()
        } else {
          this[kEmitter].emit('abort')
        }
      }, params.timeout)
    }

    // https://github.com/nodejs/node/commit/b961d9fd83
    if (INVALID_PATH_REGEX.test(requestParams.path)) {
      throw new TypeError(`ERR_UNESCAPED_CHARACTERS: ${requestParams.path}`)
    }

    debug('Starting a new request', params)
    let response
    try {
      response = await this.pool.request(requestParams)
      if (timeoutId != null) clearTimeout(timeoutId)
    } catch (err) {
      if (timeoutId != null) clearTimeout(timeoutId)
      switch (err.code) {
        case 'UND_ERR_ABORTED':
          throw (timedout ? new TimeoutError('Request timed out') : new RequestAbortedError('Request aborted'))
        case 'UND_ERR_HEADERS_TIMEOUT':
          throw new TimeoutError('Request timed out')
        default:
          throw new ConnectionError(err.message)
      }
    }

    const contentEncoding = (response.headers['content-encoding'] ?? '').toLowerCase()
    const isCompressed = contentEncoding.includes('gzip') || contentEncoding.includes('deflate')

    /* istanbul ignore else */
    if (response.headers['content-length'] !== undefined) {
      const contentLength = Number(response.headers['content-length'])
      if (isCompressed && contentLength > MAX_BUFFER_LENGTH) {
        response.body.destroy()
        throw new RequestAbortedError(`The content length (${contentLength}) is bigger than the maximum allowed buffer (${MAX_BUFFER_LENGTH})`)
      } else if (contentLength > MAX_STRING_LENGTH) {
        response.body.destroy()
        throw new RequestAbortedError(`The content length (${contentLength}) is bigger than the maximum allowed string (${MAX_STRING_LENGTH})`)
      }
    }

    this.diagnostic.emit('deserialization', null, options)
    try {
      if (isCompressed) {
        const payload: Buffer[] = []
        for await (const chunk of response.body) {
          payload.push(chunk)
        }
        return {
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(payload)
        }
      } else {
        let payload = ''
        response.body.setEncoding('utf8')
        for await (const chunk of response.body) {
          payload += chunk as string
        }
        return {
          statusCode: response.statusCode,
          headers: response.headers,
          body: payload
        }
      }
    } catch (err) {
      throw new ConnectionError(err.message)
    }
  }

  async close (): Promise<void> {
    debug('Closing connection', this.id)
    await this.pool.close()
  }
}

/* istanbul ignore next */
function isUndiciAgentOptions (opts: Record<string, any>): opts is UndiciAgentOptions {
  if (opts.keepAlive != null) return false
  if (opts.keepAliveMsecs != null) return false
  if (opts.maxSockets != null) return false
  if (opts.maxFreeSockets != null) return false
  if (opts.scheduling != null) return false
  if (opts.proxy != null) return false
  return true
}