const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const suits = ['♠','♥','♦','♣'];
const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const rooms = new Map();
const sse = new Map();

function code(){ return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0,6); }
function id(){ return crypto.randomUUID(); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]} return a; }

function deck(){
  const cards=[];
  for(let copy=0;copy<2;copy++) for(const suit of suits) for(const rank of ranks)
    cards.push({id:id(),rank,suit,label:rank+suit,jack:rank==='J',eye:rank==='J'?(suit==='♥'||suit==='♦'?'two':'one'):null});
  return shuffle(cards);
}

function board(){
  const cards=[]; let k=0; const normal=[];
  for(const s of suits) for(const r of ranks) if(r!=='J') normal.push({rank:r,suit:s,label:r+s});
  for(let y=0;y<10;y++) {
    for(let x=0;x<10;x++) {
      const corner=(x===0||x===9)&&(y===0||y===9);
      cards.push(corner?{x,y,corner:true,label:'FREE',chip:null,locked:[]}:{x,y,...normal[k++%normal.length],chip:null,locked:[]});
    }
  }
  return cards;
}

function newRoom(mode='individual', max=4){ 
  const room={code:code(), mode, max, host:null, players:[], started:false, board:board(), deck:deck(), discard:[], deadPile:[], turn:0, history:[], winner:null, deadUsed:false}; 
  rooms.set(room.code,room); 
  return room; 
}

function color(room,index){ return room.mode==='team'?(index%2?'#e53e3e':'#3182ce'):['#3182ce','#e53e3e','#38a169','#d69e2e'][index]; }

function publicState(room, playerId){
 const me=room.players.find(p=>p.id===playerId);
 return {
   code:room.code, mode:room.mode, max:room.max, host:room.host, started:room.started, 
   board:room.board, discard:room.discard.at(-1)||null, deadCard:room.deadPile.at(-1)||null,
   deckCount:room.deck.length, discardCount:room.discard.length, deadPileCount:room.deadPile.length,
   turn:room.players[room.turn]?.id||null, deadUsed:room.deadUsed, winner:room.winner, history:room.history.slice(-8), 
   players:room.players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,color:p.color,connected:p.connected,handCount:p.hand.length,sequences:p.sequences,seat:p.seat,isBot:p.isBot})),
   me:me&&{id:me.id,name:me.name,hand:me.hand,color:me.color,seat:me.seat}
 };
}

function send(room){ for(const p of room.players){ if(p.isBot) continue; const res=sse.get(p.id); if(res) res.write(`event: state\ndata: ${JSON.stringify(publicState(room,p.id))}\n\n`); } }
function startingHand(){ return 6; } // ALWAYS 6 CARDS AS REQUESTED
function teamFor(room,p){ return room.mode==='team'?p.seat%2:p.id; }

function linesFrom(room,cell,player){
 const dirs=[[1,0],[0,1],[1,1],[1,-1]], out=[]; const team=teamFor(room,player);
 for(const [dx,dy] of dirs) {
   for(let offset=-4;offset<=0;offset++){
     const pts=[]; 
     for(let n=0;n<5;n++){
       let x=cell.x+(offset+n)*dx, y=cell.y+(offset+n)*dy;
       if(x<0||y<0||x>9||y>9){pts.length=0;break}
       pts.push(room.board[y*10+x]);
     }
     if(pts.length===5 && pts.every(c=>c.corner || (c.chip&&teamFor(room,room.players.find(p=>p.id===c.chip))===team))) out.push(pts);
   }
 } 
 return out;
}

// AI COMPUTER BOT LOGIC
function checkBotTurn(room) {
    if (!room.started || room.winner) return;
    const bot = room.players[room.turn];
    if (!bot || !bot.isBot) return;

    setTimeout(() => {
        let validMoves = [];
        for(const card of bot.hand) {
            if(card.jack) {
                if(card.eye === 'two') {
                    const spots = room.board.filter(c => !c.corner && !c.chip);
                    if(spots.length) validMoves.push({card, cell: spots[Math.floor(Math.random()*spots.length)]});
                } else {
                    const spots = room.board.filter(c => !c.corner && c.chip && c.chip !== bot.id && !c.locked.length);
                    if(spots.length) validMoves.push({card, cell: spots[Math.floor(Math.random()*spots.length)]});
                }
            } else {
                const spots = room.board.filter(c => !c.corner && !c.chip && c.rank === card.rank && c.suit === card.suit);
                if(spots.length) {
                    validMoves.push({card, cell: spots[Math.floor(Math.random()*spots.length)]});
                } else {
                    const fullSpots = room.board.filter(c => !c.corner && c.rank === card.rank && c.suit === card.suit);
                    if(fullSpots.length > 0 && fullSpots.every(x => x.chip !== null)) {
                        validMoves.push({card, dead: true}); // It's a dead card
                    }
                }
            }
        }

        if(validMoves.length > 0) {
            const move = validMoves[Math.floor(Math.random() * validMoves.length)];
            try {
                if(move.dead && !room.deadUsed) {
                    action(room, bot, {type: 'dead', cardId: move.card.id});
                    checkBotTurn(room); // Play normal turn after discard
                } else if (!move.dead) {
                    action(room, bot, {type: 'play', cardId: move.card.id, x: move.cell.x, y: move.cell.y});
                }
            } catch(e) { 
                room.turn = (room.turn + 1) % room.players.length; send(room); checkBotTurn(room);
            }
        } else {
            room.turn = (room.turn + 1) % room.players.length; send(room); checkBotTurn(room);
        }
    }, 2000);
}

function finishMove(room,p,card,desc){ p.hand=p.hand.filter(c=>c.id!==card.id); room.discard.push(card); if(!room.deck.length){room.deck=shuffle(room.discard.splice(0));} if(room.deck.length)p.hand.push(room.deck.pop()); room.history.push({text:`${p.name} ${desc}`}); room.deadUsed=false; room.turn=(room.turn+1)%room.players.length; send(room); checkBotTurn(room); }

function action(room, player, a){
 if(!room.started||room.winner) throw Error('The game is not currently accepting moves.');
 if(room.players[room.turn]?.id!==player.id) throw Error('It is not your turn.');
 const card=player.hand.find(c=>c.id===a.cardId); if(!card) throw Error('That card is not in your hand.');
 
 if(a.type==='dead'){
   if(room.deadUsed||card.jack) throw Error('That card cannot be exchanged now.');
   const spots=room.board.filter(c=>!c.corner&&!c.chip&&c.rank===card.rank&&c.suit===card.suit); 
   if(spots.length > 0) throw Error('This card still has an open board space. It is not dead.');
   
   player.hand=player.hand.filter(c=>c.id!==card.id);
   room.deadPile.push(card); 
   if(room.deck.length) player.hand.push(room.deck.pop());
   
   room.deadUsed=true;
   room.history.push({text:`${player.name} exchanged a dead card`});
   send(room);
   return;
 }
 
 const cell=room.board.find(c=>c.x===a.x&&c.y===a.y); if(!cell) throw Error('Invalid board space.');
 if(card.eye==='one'){
   if(!cell.chip || cell.locked.length || teamFor(room,room.players.find(p=>p.id===cell.chip))===teamFor(room,player)) throw Error('Choose an unprotected opponent chip.');
   cell.chip=null; finishMove(room,player,card,'played a one-eyed Jack'); return;
 }
 if(cell.chip||cell.corner) throw Error('Choose an empty board space.');
 if(!card.eye && (cell.rank!==card.rank||cell.suit!==card.suit)) throw Error('That space does not match the selected card.');
 cell.chip=player.id; const sequences=linesFrom(room,cell,player); for(const seq of sequences){ const key=seq.map(c=>`${c.x},${c.y}`).join('|'); if(!room.sequenceKeys?.includes(key)){room.sequenceKeys??=[];room.sequenceKeys.push(key);seq.forEach(c=>c.locked.push(key));player.sequences++;} }
 const target=room.mode==='team'?2:(room.max===2?2:1); const combined=room.players.filter(q=>teamFor(room,q)===teamFor(room,player)).reduce((n,q)=>n+q.sequences,0); if(combined>=target){room.winner={team:room.mode==='team',name:room.mode==='team'?(player.seat%2?'RED TEAM':'BLUE TEAM'):player.name,color:player.color};room.history.push({text:`${room.winner.name} completed the game!`});send(room);return;}
 finishMove(room,player,card,card.eye==='two'?'played a two-eyed Jack':`placed ${card.label}`);
}

function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}

const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/events'){const pid=url.searchParams.get('player');res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});sse.set(pid,res);req.on('close',()=>sse.delete(pid)); for(const room of rooms.values())if(room.players.some(p=>p.id===pid))send(room);return;}
 if(req.method==='POST'&&url.pathname.startsWith('/api/')){let body='';req.on('data',d=>body+=d);req.on('end',()=>{try{const b=JSON.parse(body||'{}');
   if(url.pathname==='/api/create'){
       const isComp = b.mode === 'computer';
       const room=newRoom(isComp ? 'individual' : b.mode, isComp ? 2 : b.max);
       const p={id:id(),name:b.name||'Host',avatar:b.avatar||'🦊',seat:0,color:color(room,0),hand:[],sequences:0,connected:true,isBot:false};
       room.host=p.id;room.players.push(p);
       if(isComp) {
           const bot={id:id(),name:'AlphaBot (CPU)',avatar:'🤖',seat:1,color:color(room,1),hand:[],sequences:0,connected:true,isBot:true};
           room.players.push(bot);
       }
       json(res,200,{room:room.code,player:p.id});return;
   }
   if(url.pathname==='/api/join'){const room=rooms.get(b.room?.toUpperCase());if(!room)throw Error('Room not found.');if(room.started)throw Error('This game has already started.');if(room.players.length>=room.max)throw Error('This table is full.');const seat=room.players.length;const p={id:id(),name:b.name||`Player ${seat+1}`,avatar:b.avatar||'🦊',seat,color:color(room,seat),hand:[],sequences:0,connected:true,isBot:false};room.players.push(p);send(room);json(res,200,{room:room.code,player:p.id});return;}
   const room=rooms.get(b.room?.toUpperCase());const p=room?.players.find(p=>p.id===b.player);if(!room||!p)throw Error('Your game session is no longer available.');
   if(url.pathname==='/api/start'){
       if(room.host!==p.id)throw Error('Only the host can start.');if(room.players.length<2)throw Error('At least two players are needed.');
       room.started=true;room.players.forEach(q=>{q.hand=[];for(let i=0;i<startingHand();i++)q.hand.push(room.deck.pop())});
       room.history.push({text:'The table is set — game started.'});send(room); checkBotTurn(room); json(res,200,{ok:true});return;
   }
   if(url.pathname==='/api/action'){action(room,p,b.action);json(res,200,{ok:true});return;}
   throw Error('Unknown request.');
 }catch(e){json(res,400,{error:e.message});}});return;}
 const file=url.pathname==='/'?'index.html':url.pathname.slice(1); const safe=path.join(root,file);if(!safe.startsWith(root)||!fs.existsSync(safe)){res.writeHead(404);res.end('Not found');return;}res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'text/html'});fs.createReadStream(safe).pipe(res);
});

server.listen(process.env.PORT||3000,()=>console.log('Sequence Table (10x10) ready at http://localhost:3000'));
