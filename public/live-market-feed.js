// OptionEdge AI — Upstox V3 browser market stream.
// Broker access tokens stay server-side. The browser receives only Upstox's one-use websocket URI.
(function(){
  const API=(window.__HATCHABLE__&&window.__HATCHABLE__.api)||'/api';
  const FEED_TYPE='com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse';
  const state={socket:null,reconnectTimer:null,reconnectAttempt:0,stopped:false,onTick:null,onState:null,subscriptions:new Set(['NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank']),proto:null};

  window.optionEdgeLiveFeed={
    socket:null,
    reconnectTimer:null,
    reconnectAttempt:0,
    stopped:false,
    onTick:null,
    onState:null,
    subscriptions:state.subscriptions,
    subscribe(keys){
      for(const key of (keys||[])) if(key) state.subscriptions.add(key);
      if(state.socket&&state.socket.readyState===WebSocket.OPEN) sendSubscription();
    },
    connect(onTick,onState){
      state.onTick=onTick||state.onTick;
      state.onState=onState||state.onState;
      state.stopped=false;
      this.onTick=state.onTick;this.onState=state.onState;
      return connect();
    },
    disconnect(){
      state.stopped=true;clearTimeout(state.reconnectTimer);state.reconnectTimer=null;
      if(state.socket){try{state.socket.close();}catch(e){}state.socket=null;}
      this.socket=null;
      if(state.onState)state.onState('DISCONNECTED');
    }
  };

  function emitState(s){if(state.onState)state.onState(s);}
  function sendSubscription(){
    if(!state.socket||state.socket.readyState!==WebSocket.OPEN)return;
    const payload={guid:'optionedge-'+Date.now().toString(36),method:'sub',data:{mode:'ltpc',instrumentKeys:[...state.subscriptions]}};
    // Upstox V3 expects the JSON subscription payload as binary UTF-8 bytes.
    state.socket.send(new TextEncoder().encode(JSON.stringify(payload)));
  }
  async function getProto(){
    if(state.proto)return state.proto;
    if(!window.protobuf)throw new Error('PROTOBUF_DECODER_NOT_LOADED');
    const root=await protobuf.load('/MarketDataFeedV3.proto');
    state.proto=root.lookupType(FEED_TYPE);
    if(!state.proto)throw new Error('UPSTOX_FEED_PROTO_TYPE_NOT_FOUND');
    return state.proto;
  }
  async function authorize(){
    const r=await fetch(API+'/upstox-market-feed-authorize',{headers:{Accept:'application/json'}});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||d.message||'MARKET_FEED_AUTHORIZE_FAILED');
    const url=d.authorized_redirect_uri||d.websocket_url||d.data?.authorized_redirect_uri;
    if(!url)throw new Error('MARKET_FEED_SOCKET_URL_MISSING');
    return url;
  }
  function extractTicks(message){
    const feeds=message?.feeds||{};const ticks=[];
    for(const [instrument_key,feed] of Object.entries(feeds)){
      const ltp=feed?.ltpc?.ltp
        ?? feed?.fullFeed?.marketFF?.ltpc?.ltp
        ?? feed?.fullFeed?.indexFF?.ltpc?.ltp
        ?? feed?.firstLevelWithGreeks?.ltpc?.ltp;
      if(Number.isFinite(Number(ltp)))ticks.push({instrument_key,ltp:Number(ltp),tick_ts:message?.currentTs||Date.now()});
    }
    return ticks;
  }
  async function connect(){
    if(state.socket&&(state.socket.readyState===WebSocket.OPEN||state.socket.readyState===WebSocket.CONNECTING))return;
    emitState('CONNECTING');
    try{
      await getProto();
      const url=await authorize();
      const ws=new WebSocket(url);ws.binaryType='arraybuffer';state.socket=ws;
      window.optionEdgeLiveFeed.socket=ws;
      ws.onopen=()=>{state.reconnectAttempt=0;emitState('LIVE');sendSubscription();};
      ws.onmessage=async(ev)=>{
        try{
          let buffer=ev.data;
          if(buffer instanceof Blob)buffer=await buffer.arrayBuffer();
          if(!(buffer instanceof ArrayBuffer))return;
          const msg=state.proto.decode(new Uint8Array(buffer));
          const obj=state.proto.toObject(msg,{longs:Number,enums:String,defaults:false});
          const ticks=extractTicks(obj);
          if(ticks.length&&state.onTick)state.onTick(ticks);
        }catch(e){
          // Keep the connection alive on an isolated decode error; the next tick may be valid.
          console.warn('OptionEdge market-feed decode error',e);
        }
      };
      ws.onerror=()=>emitState('ERROR');
      ws.onclose=()=>{
        if(state.socket===ws)state.socket=null;
        window.optionEdgeLiveFeed.socket=null;
        emitState('DISCONNECTED');
        if(!state.stopped){
          const delay=Math.min(10000,1000*Math.pow(2,state.reconnectAttempt++));
          clearTimeout(state.reconnectTimer);state.reconnectTimer=setTimeout(connect,delay);
        }
      };
    }catch(e){
      console.warn('OptionEdge market-feed connection error',e);
      emitState('ERROR');
      if(!state.stopped){
        const delay=Math.min(10000,1000*Math.pow(2,state.reconnectAttempt++));
        clearTimeout(state.reconnectTimer);state.reconnectTimer=setTimeout(connect,delay);
      }
    }
  }
})();