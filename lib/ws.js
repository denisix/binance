const WebSocket = require('ws');
const Beautifier = require('./beautifier.js');
const _ = require('underscore');
const EventEmitter = require('events')

const BinanceErrors = Object.freeze({
    INVALID_LISTEN_KEY: -1125
});

class WS extends EventEmitter {
    constructor(uri, keepAliveSeconds = 60) {
        super()

        this.uri = uri
        this.timer = null
        this.isAlive = false
        this.ws = null
        this.keepAliveSeconds = keepAliveSeconds

        this.setup(uri)
    }

    onopen() {
        console.log(new Date().toLocaleString('uk'), '- WS stream opened')
        this.isAlive = true
        this.emit('wsopen')

        this.timer = setInterval(() => {
            if (!this.isAlive) return this.setup(this.uri)
            this.isAlive = false

            // check if WS opened else it will throw an exception
            if (this.ws && this.ws.readyState === this.ws.OPEN) {
                this.ws.pong() // unsoliciated pong permitted
                this.ws.ping()
            }
        }, this.keepAliveSeconds * 1000)
    }

    onerror(e) {
        console.log(new Date().toLocaleString('uk'), '- WS err:', e)
        if (this.ws && this.ws.readyState === this.ws.OPEN) this.isAlive = true
        this.emit('wserror', e)
    }

    onclose(e) {
        console.log(new Date().toLocaleString('uk'), '- WS disconnect:', e)
        if (this.ws && this.ws.readyState === this.ws.OPEN) this.isAlive = true
        clearInterval(this.timer)
        this.setup(this.uri)
        this.emit('wsclose', e)
    }

    onpong() {
        console.log(new Date().toLocaleString('uk'), '- WS PONG received')
        this.isAlive = true
    }

    onping() {
        console.log(new Date().toLocaleString('uk'), '- WS PING received')
        this.isAlive = true
        try {
            this.ws.pong()
        } catch (e) {
            console.error('WS pong err:', e && e.toString())
            this.emit('wserror', e)
        }
    }

    onmessage(e) {
        this.emit('wsmessage', e)
    }

    setup(uri) {
        console.log(new Date().toLocaleString('uk'), '- WS setup', uri)
        if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.terminate()

        this.ws = new WebSocket(uri)
        this.ws
            .on('open', this.onopen.bind(this))
            .on('error', this.onerror.bind(this))
            .on('close', this.onclose.bind(this))
            .on('pong', this.onpong.bind(this))
            .on('ping', this.onping.bind(this))
            .on('message', this.onmessage.bind(this))

        this.isAlive = true
    }
}

class BinanceWS {
    constructor(beautify = true) {
        this._baseUrl = 'wss://stream.binance.com:9443/ws/';
        this._combinedBaseUrl = 'wss://stream.binance.com:9443/stream?streams=';
        this._sockets = {};
        this._beautifier = new Beautifier();
        this._beautify = beautify;

        this.streams = {
            depth: symbol => `${symbol.toLowerCase()}@depth`,
            depthLevel: (symbol, level) =>
                `${symbol.toLowerCase()}@depth${level}`,
            kline: (symbol, interval) =>
                `${symbol.toLowerCase()}@kline_${interval}`,
            aggTrade: symbol => `${symbol.toLowerCase()}@aggTrade`,
            trade: symbol => `${symbol.toLowerCase()}@trade`,
            ticker: symbol => `${symbol.toLowerCase()}@ticker`,
            allTickers: () => '!ticker@arr'
        };

        // Reference to the setInterval timer for sending keep alive requests in onUserData
        this._userDataRefresh = {
            intervaId: false,
            failCount: 0
        };
    }

    _setupWebSocket(eventHandler, path, isCombined) {
        if (this._sockets[path]) {
            return this._sockets[path];
        }
        path = (isCombined ? this._combinedBaseUrl : this._baseUrl) + path;
        const ws = new WS(path);

        ws.on('wsmessage', message => {
            let event;
            try {
                event = JSON.parse(message);
            } catch (e) {
                event = message;
            }
            if (this._beautify) {
                if (event.stream) {
                    event.data = this._beautifyResponse(event.data);
                } else {
                    event = this._beautifyResponse(event);
                }
            }

            eventHandler(event);
        });

        return ws;
    }

    _beautifyResponse(data) {
        if (_.isArray(data)) {
            return _.map(data, event => {
                if (event.e) {
                    return this._beautifier.beautify(event, event.e + 'Event');
                }
                return event;
            });
        } else if (data.e) {
            return this._beautifier.beautify(data, data.e + 'Event');
        }
        return data;
    }

    _clearUserDataInterval() {
        if (this._userDataRefresh.intervaId) {
            clearInterval(this._userDataRefresh.intervaId);
        }

        this._userDataRefresh.intervaId = false;
        this._userDataRefresh.failCount = 0;
    }

    _sendUserDataKeepAlive(binanceRest, response) {
        return binanceRest.keepAliveUserDataStream(response).catch(e => {
            this._userDataRefresh.failCount++;
            const msg =
                'Failed requesting keepAliveUserDataStream for onUserData listener';
            if (e && e.code === BinanceErrors.INVALID_LISTEN_KEY) {
                console.error(
                    new Date(),
                    msg,
                    'listen key expired - clearing keepAlive interval',
                    e
                );
                this._clearUserDataInterval();
                return;
            }
            console.error(
                new Date(),
                msg,
                'failCount: ',
                this._userDataRefresh.failCount,
                e
            );
        });
    }

    onDepthUpdate(symbol, eventHandler) {
        return this._setupWebSocket(eventHandler, this.streams.depth(symbol));
    }

    onDepthLevelUpdate(symbol, level, eventHandler) {
        return this._setupWebSocket(
            eventHandler,
            this.streams.depthLevel(symbol, level)
        );
    }

    onKline(symbol, interval, eventHandler) {
        return this._setupWebSocket(
            eventHandler,
            this.streams.kline(symbol, interval)
        );
    }

    onAggTrade(symbol, eventHandler) {
        return this._setupWebSocket(
            eventHandler,
            this.streams.aggTrade(symbol)
        );
    }

    onTrade(symbol, eventHandler) {
        return this._setupWebSocket(eventHandler, this.streams.trade(symbol));
    }

    onTicker(symbol, eventHandler) {
        return this._setupWebSocket(eventHandler, this.streams.ticker(symbol));
    }

    onAllTickers(eventHandler) {
        return this._setupWebSocket(eventHandler, this.streams.allTickers());
    }

    onUserData(binanceRest, eventHandler, interval = 60000) {
        this._clearUserDataInterval();
        return binanceRest.startUserDataStream().then(response => {
            this._userDataRefresh.intervaId = setInterval(
                () => this._sendUserDataKeepAlive(binanceRest, response),
                interval
            );
            this._userDataRefresh.failCount = 0;

            return this._setupWebSocket(eventHandler, response.listenKey);
        });
    }

    onCombinedStream(streams, eventHandler) {
        return this._setupWebSocket(eventHandler, streams.join('/'), true);
    }
}

module.exports = BinanceWS;
