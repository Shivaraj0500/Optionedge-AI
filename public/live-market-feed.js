// OptionEdge AI — browser-side Upstox V3 LTPC stream.
// The server only returns Upstox's short-lived authorized websocket URI; the broker access token stays server-side.
(function(){
  const API=(window.__HATCHABLE__&&window.__HATCHABLE__.api)||'/api';
  window.optionEdgeLiveFeed={
    socket:null,
    reconnectTimer:null,
    reconnectAttempt:0,
    stopped:false,
    onTick:null,
    onState:null,
    async connect(onTick,onState){
      this.onTick=onTick||this.onTick;
      this.onState=onState||this.onState;
      this.stopped=false;
      if(this.socket && (this.socket.readyState===WebSocket.OPEN || this.socket.readyState===WebSocket.CONNECTING)) return;
      if(this.onState) this.onState('CONNECTING');
      try{
        const r=await fetch(API+'/upstox-market-feed-authorize',{headers:{Accept:'application/json'}});
        const d=await r.json().catch(()=>({}));
        if(!r.ok || !d.authorized_redirect_uri) throw new Error(d.error||'MARKET_FEED_AUTHORIZE_FAILED');
        const ws=new WebSocket(d.authorized_redirect_uri);
        this.socket=ws;
        ws.binaryType='arraybuffer';
        ws.onopen=()=>{
          this.reconnectAttempt=0;
          if(this.onState) this.onState('LIVE');
          const payload={guid:'optionedge-'+Date.now().toString(36),method:'sub',data:{mode:'ltpc',instrumentKeys:['NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank']}};
          ws.send(new TextEncoder().encode(JSON.stringify(payload)));
        };
        ws.onmessage=async(ev)=>{
          try{
            const buf=ev.data instanceof ArrayBuffer?ev.data:await ev.data.arrayBuffer();
            const ticks=decodeFeedResponse(buf);
            if(this.onTick) this.onTick(ticks);
          }catch(e){ if(this.onState) this.onState('DECODE_ERROR'); }
        };
        ws.onerror=()=>{ if(this.onState) this.onState('ERROR'); };
        ws.onclose=()=>{
          if(this.socket===ws) this.socket=null;
          if(this.onState) this.onState('DISCONNECTED');
          if(!this.stopped){
            const delay=Math.min(10000,1000*Math.pow(2,this.reconnectAttempt++));
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer=setTimeout(()=>this.connect(),delay);
          }
        };
      }catch(e){
        if(this.onState) this.onState('ERROR');
        if(!this.stopped){
          const delay=Math.min(10000,1000*Math.pow(2,this.reconnectAttempt++));
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer=setTimeout(()=>this.connect(),delay);
        }
      }
    },
    disconnect(){
      this.stopped=true;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer=null;
      if(this.socket){try{this.socket.close();}catch(e){} this.socket=null;}
      if(this.onState) this.onState('DISCONNECTED');
    }
  };

  function readVarint(bytes,state){
    let value=0n,shift=0n;
    while(state.i<bytes.length){
      const b=bytes[state.i++];
      value|=BigInt(b&127)<<shift;
      if(!(b&128)) return value;
      shift+=7n;
      if(shift>70n) throw new Error('VARINT_TOO_LARGE');
    }
    throw new Error('TRUNCATED_VARINT');
  }
  function readLen(bytes,state){const n=Number(readVarint(bytes,state));const start=state.i;const end=start+n;if(end>bytes.length)throw new Error('TRUNCATED_FIELD');state.i=end;return bytes.subarray(start,end);}
  function readFixed64(bytes,state){const start=state.i;state.i+=8;if(state.i>bytes.length)throw new Error('TRUNCATED_FIXED64');return new DataView(bytes.buffer,bytes.byteOffset+start,8).getFloat64(0,true);}
  function skip(bytes,state,wire){if(wire===0){readVarint(bytes,state);return;}if(wire===1){state.i+=8;return;}if(wire===2){readLen(bytes,state);return;}if(wire===5){state.i+=4;return;}throw new Error('UNSUPPORTED_WIRE_TYPE');}
  function parseLtpc(bytes){
    const state={i:0};let ltp=null;
    while(state.i<bytes.length){
      const tag=Number(readVarint(bytes,state));const field=tag>>>3;const wire=tag&7;
      if(field===1&&wire===1) ltp=readFixed64(bytes,state);
      else skip(bytes,state,wire);
    }
    return ltp;
  }
  function parseFeed(bytes){
    const state={i:0};let ltp=null;
    while(state.i<bytes.length){
      const tag=Number(readVarint(bytes,state));const field=tag>>>3;const wire=tag&7;
      if((field===1||field===2||field===3)&&wire===2){
        const nested=readLen(bytes,state);
        if(field===1){const v=parseLtpc(nested);if(v!==null)ltp=v;}
        else if(field===2){
          // FullFeed may wrap an indexFF/marketFF; indexFF is field 2 and contains ltpc field 1.
          const s={i:0};
          while(s.i<nested.length){
            const t=Number(readVarint(nested,s));const f=t>>>3;const w=t&7;
            if(f===2&&w===2){const index=readLen(nested,s);const v=parseLtpcFromIndex(index);if(v!==null)ltp=v;}
            else if(f===1&&w===2){const market=readLen(nested,s);const v=parseLtpcFromMarket(market);if(v!==null)ltp=v;}
            else skip(nested,s,w);
          }
        }
      }else skip(bytes,state,wire);
    }
    return ltp;
  }
  function parseLtpcFromIndex(bytes){const state={i:0};while(state.i<bytes.length){const tag=Number(readVarint(bytes,state));const field=tag>>>3;const wire=tag&7;if(field===1&&wire===2)return parseLtpc(readLen(bytes,state));skip(bytes,state,wire);}return null;}
  function parseLtpcFromMarket(bytes){const state={i:0};while(state.i<bytes.length){const tag=Number(readVarint(bytes,state));const field=tag>>>3;const wire=tag&7;if(field===1&&wire===2)return parseLtpc(readLen(bytes,state));skip(bytes,state,wire);}return null;}
  function parseMapEntry(bytes){
    const state={i:0};let key=null,value=null;
    while(state.i<bytes.length){const tag=Number(readVarint(bytes,state));const field=tag>>>3;const wire=tag&7;if(field===1&&wire===2)key=new TextDecoder().decode(readLen(bytes,state));else if(field===2&&wire===2)value=readLen(bytes,state);else skip(bytes,state,wire);}
    return {key,value};
  }
  function decodeFeedResponse(buffer){
    const bytes=new Uint8Array(buffer),state={i:0},out=[];
    while(state.i<bytes.length){const tag=Number(readVarint(bytes,state));const field=tag>>>3;const wire=tag&7;if(field===2&&wire===2){const entry=parseMapEntry(readLen(bytes,state));if(entry.key&&entry.value){const ltp=parseFeed(entry.value);if(Number.isFinite(ltp))out.push({instrument_key:entry.key,ltp});}}else skip(bytes,state,wire);}
    return out;
  }
})();