const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;

const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const rooms = new Map();
const sse = new Map();

function code() {
    return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

function id() {
    return crypto.randomUUID();
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

function deck() {
    const cards = [];

    for (let copy = 0; copy < 2; copy++) {
        for (const suit of suits) {
            for (const rank of ranks) {
                cards.push({
                    id: id(),
                    rank,
                    suit,
                    label: rank + suit,
                    jack: rank === 'J',
                    eye:
                        rank === 'J'
                            ? suit === '♥' || suit === '♦'
                                ? 'two'
                                : 'one'
                            : null
                });
            }
        }
    }

    return shuffle(cards);
}

function board() {
    const cards = [];
    let k = 0;
    const normal = [];

    // Normal cards exclude Jacks
    for (const suit of suits) {
        for (const rank of ranks) {
            if (rank !== 'J') {
                normal.push({
                    rank,
                    suit,
                    label: rank + suit
                });
            }
        }
    }

    // Create 10x10 grid (100 spaces)
    for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
            // Corners are at 0,0 | 0,9 | 9,0 | 9,9
            const corner =
                (x === 0 || x === 9) &&
                (y === 0 || y === 9);

            cards.push(
                corner
                    ? {
                          x,
                          y,
                          corner: true,
                          label: 'FREE',
                          chip: null,
                          locked: []
                      }
                    : {
                          x,
                          y,
                          ...normal[k++ % normal.length],
                          chip: null,
                          locked: []
                      }
            );
        }
    }

    return cards;
}

function newRoom(mode = 'individual', max = 4) {
    const room = {
        code: code(),
        mode,
        max,
        host: null,
        players: [],
        started: false,
        board: board(),
        deck: deck(),
        discard: [],
        turn: 0,
        history: [],
        winner: null,
        deadUsed: false
    };

    rooms.set(room.code, room);

    return room;
}

function color(room, index) {
    return room.mode === 'team'
        ? index % 2
            ? '#d45a4f'
            : '#2f82c9'
        : ['#2f82c9', '#d45a4f', '#45a66e', '#d6a63f'][index];
}

function publicState(room, playerId) {
    const me = room.players.find(
        player => player.id === playerId
    );

    return {
        code: room.code,
        mode: room.mode,
        max: room.max,
        host: room.host,
        started: room.started,
        board: room.board,
        discard: room.discard.at(-1) || null,
        deckCount: room.deck.length,
        turn: room.players[room.turn]?.id || null,
        deadUsed: room.deadUsed,
        winner: room.winner,
        history: room.history.slice(-8),

        players: room.players.map(player => ({
            id: player.id,
            name: player.name,
            avatar: player.avatar,
            color: player.color,
            connected: player.connected,
            handCount: player.hand.length,
            sequences: player.sequences,
            seat: player.seat
        })),

        me:
            me && {
                id: me.id,
                name: me.name,
                hand: me.hand,
                color: me.color,
                seat: me.seat
            }
    };
}

function send(room) {
    for (const player of room.players) {
        const res = sse.get(player.id);

        if (res) {
            res.write(
                `event: state\ndata: ${JSON.stringify(
                    publicState(room, player.id)
                )}\n\n`
            );
        }
    }
}

function startingHand(max) {
    return max === 2 ? 7 : 6;
}

function teamFor(room, player) {
    return room.mode === 'team'
        ? player.seat % 2
        : player.id;
}

function linesFrom(room, cell, player) {
    const dirs = [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, -1]
    ];

    const out = [];
    const team = teamFor(room, player);

    for (const [dx, dy] of dirs) {
        for (let offset = -4; offset <= 0; offset++) {
            const pts = [];

            for (let n = 0; n < 5; n++) {
                const x = cell.x + (offset + n) * dx;
                const y = cell.y + (offset + n) * dy;

                // Boundary check for 10x10 board
                // Maximum coordinate is 9
                if (
                    x < 0 ||
                    y < 0 ||
                    x > 9 ||
                    y > 9
                ) {
                    pts.length = 0;
                    break;
                }

                pts.push(room.board[y * 10 + x]);
            }

            if (
                pts.length === 5 &&
                pts.every(
                    c =>
                        c.corner ||
                        (
                            c.chip &&
                            teamFor(
                                room,
                                room.players.find(
                                    p => p.id === c.chip
                                )
                            ) === team
                        )
                )
            ) {
                out.push(pts);
            }
        }
    }

    return out;
}

function finishMove(room, player, card, desc) {
    player.hand = player.hand.filter(
        c => c.id !== card.id
    );

    room.discard.push(card);

    if (!room.deck.length) {
        room.deck = shuffle(
            room.discard.splice(0)
        );
    }

    if (room.deck.length) {
        player.hand.push(room.deck.pop());
    }

    room.history.push({
        text: `${player.name} ${desc}`
    });

    room.deadUsed = false;

    room.turn =
        (room.turn + 1) % room.players.length;

    send(room);
}

function action(room, player, actionData) {
    if (!room.started || room.winner) {
        throw Error(
            'The game is not currently accepting moves.'
        );
    }

    if (
        room.players[room.turn]?.id !== player.id
    ) {
        throw Error('It is not your turn.');
    }

    const card = player.hand.find(
        c => c.id === actionData.cardId
    );

    if (!card) {
        throw Error(
            'That card is not in your hand.'
        );
    }

    // Dead card exchange
    if (actionData.type === 'dead') {
        if (room.deadUsed || card.jack) {
            throw Error(
                'That card cannot be exchanged now.'
            );
        }

        const spots = room.board.filter(
            c =>
                !c.corner &&
                !c.chip &&
                c.rank === card.rank &&
                c.suit === card.suit
        );

        if (spots.length) {
            throw Error(
                'This card still has an open board space.'
            );
        }

        player.hand = player.hand.filter(
            c => c.id !== card.id
        );

        room.discard.push(card);

        if (room.deck.length) {
            player.hand.push(
                room.deck.pop()
            );
        }

        room.deadUsed = true;

        room.history.push({
            text: `${player.name} exchanged a dead card`
        });

        send(room);

        return;
    }

    const cell = room.board.find(
        c =>
            c.x === actionData.x &&
            c.y === actionData.y
    );

    if (!cell) {
        throw Error('Invalid board space.');
    }

    // One-eyed Jack: remove an opponent chip
    if (card.eye === 'one') {
        if (
            !cell.chip ||
            cell.locked.length ||
            teamFor(
                room,
                room.players.find(
                    p => p.id === cell.chip
                )
            ) === teamFor(room, player)
        ) {
            throw Error(
                'Choose an unprotected opponent chip.'
            );
        }

        cell.chip = null;

        finishMove(
            room,
            player,
            card,
            'played a one-eyed Jack'
        );

        return;
    }

    // Normal cards / two-eyed Jack
    if (cell.chip || cell.corner) {
        throw Error(
            'Choose an empty board space.'
        );
    }

    if (
        !card.eye &&
        (
            cell.rank !== card.rank ||
            cell.suit !== card.suit
        )
    ) {
        throw Error(
            'That space does not match the selected card.'
        );
    }

    cell.chip = player.id;

    const sequences = linesFrom(
        room,
        cell,
        player
    );

    for (const sequence of sequences) {
        const key = sequence
            .map(c => `${c.x},${c.y}`)
            .join('|');

        if (!room.sequenceKeys?.includes(key)) {
            room.sequenceKeys ??= [];

            room.sequenceKeys.push(key);

            sequence.forEach(c =>
                c.locked.push(key)
            );

            player.sequences++;
        }
    }

    const target =
        room.mode === 'team'
            ? 2
            : room.max === 2
                ? 2
                : 1;

    const combined = room.players
        .filter(
            q =>
                teamFor(room, q) ===
                teamFor(room, player)
        )
        .reduce(
            (total, q) =>
                total + q.sequences,
            0
        );

    if (combined >= target) {
        room.winner = {
            team: room.mode === 'team',
            name:
                room.mode === 'team'
                    ? player.seat % 2
                        ? 'RED TEAM'
                        : 'BLUE TEAM'
                    : player.name,
            color: player.color
        };

        room.history.push({
            text: `${room.winner.name} completed the game!`
        });

        send(room);

        return;
    }

    finishMove(
        room,
        player,
        card,
        card.eye === 'two'
            ? 'played a two-eyed Jack'
            : `placed ${card.label}`
    );
}

function json(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json'
    });

    res.end(
        JSON.stringify(data)
    );
}

const server = http.createServer(
    (req, res) => {
        const url = new URL(
            req.url,
            'http://localhost'
        );

        // Server-Sent Events
        if (
            req.method === 'GET' &&
            url.pathname === '/events'
        ) {
            const playerId =
                url.searchParams.get('player');

            res.writeHead(200, {
                'Content-Type':
                    'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            sse.set(playerId, res);

            req.on('close', () => {
                sse.delete(playerId);
            });

            for (const room of rooms.values()) {
                if (
                    room.players.some(
                        p => p.id === playerId
                    )
                ) {
                    send(room);
                }
            }

            return;
        }

        // API routes
        if (
            req.method === 'POST' &&
            url.pathname.startsWith('/api/')
        ) {
            let body = '';

            req.on('data', data => {
                body += data;
            });

            req.on('end', () => {
                try {
                    const b =
                        JSON.parse(body || '{}');

                    // Create room
                    if (
                        url.pathname ===
                        '/api/create'
                    ) {
                        const room = newRoom(
                            b.mode,
                            b.max
                        );

                        const player = {
                            id: id(),
                            name: b.name || 'Host',
                            avatar: b.avatar || '🦊',
                            seat: 0,
                            color: color(room, 0),
                            hand: [],
                            sequences: 0,
                            connected: true
                        };

                        room.host = player.id;
                        room.players.push(player);

                        json(res, 200, {
                            room: room.code,
                            player: player.id
                        });

                        return;
                    }

                    // Join room
                    if (
                        url.pathname ===
                        '/api/join'
                    ) {
                        const room = rooms.get(
                            b.room?.toUpperCase()
                        );

                        if (!room) {
                            throw Error(
                                'Room not found.'
                            );
                        }

                        if (room.started) {
                            throw Error(
                                'This game has already started.'
                            );
                        }

                        if (
                            room.players.length >=
                            room.max
                        ) {
                            throw Error(
                                'This table is full.'
                            );
                        }

                        const seat =
                            room.players.length;

                        const player = {
                            id: id(),
                            name:
                                b.name ||
                                `Player ${seat + 1}`,
                            avatar:
                                b.avatar || '🦊',
                            seat,
                            color: color(
                                room,
                                seat
                            ),
                            hand: [],
                            sequences: 0,
                            connected: true
                        };

                        room.players.push(player);

                        send(room);

                        json(res, 200, {
                            room: room.code,
                            player: player.id
                        });

                        return;
                    }

                    const room = rooms.get(
                        b.room?.toUpperCase()
                    );

                    const player =
                        room?.players.find(
                            p => p.id === b.player
                        );

                    if (!room || !player) {
                        throw Error(
                            'Your game session is no longer available.'
                        );
                    }

                    // Start game
                    if (
                        url.pathname ===
                        '/api/start'
                    ) {
                        if (
                            room.host !== player.id
                        ) {
                            throw Error(
                                'Only the host can start.'
                            );
                        }

                        if (
                            room.players.length < 2
                        ) {
                            throw Error(
                                'At least two players are needed.'
                            );
                        }

                        room.started = true;

                        room.players.forEach(
                            p => {
                                p.hand = [];

                                for (
                                    let i = 0;
                                    i <
                                    startingHand(
                                        room.max
                                    );
                                    i++
                                ) {
                                    p.hand.push(
                                        room.deck.pop()
                                    );
                                }
                            }
                        );

                        room.history.push({
                            text:
                                'The table is set — game started.'
                        });

                        send(room);

                        json(res, 200, {
                            ok: true
                        });

                        return;
                    }

                    // Player action
                    if (
                        url.pathname ===
                        '/api/action'
                    ) {
                        action(
                            room,
                            player,
                            b.action
                        );

                        json(res, 200, {
                            ok: true
                        });

                        return;
                    }

                    throw Error(
                        'Unknown request.'
                    );
                } catch (error) {
                    json(res, 400, {
                        error: error.message
                    });
                }
            });

            return;
        }

        // Serve frontend files
        const file =
            url.pathname === '/'
                ? 'index.html'
                : url.pathname.slice(1);

        const safe = path.join(
            root,
            file
        );

        if (
            !safe.startsWith(root) ||
            !fs.existsSync(safe)
        ) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        res.writeHead(200, {
            'Content-Type':
                file.endsWith('.css')
                    ? 'text/css'
                    : 'text/html'
        });

        fs.createReadStream(safe).pipe(res);
    }
);

server.listen(
    process.env.PORT || 3000,
    () =>
        console.log(
            'Sequence Table ready at http://localhost:3000'
        )
);
