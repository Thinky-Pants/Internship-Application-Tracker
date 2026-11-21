// Generates simple PNG app icons without image dependencies.
import zlib from "node:zlib";
import fs from "node:fs";
function crc32(buf){let c,crc=0xffffffff;for(let n=0;n<buf.length;n++){c=(crc^buf[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c;}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);}
function png(size){const raw=Buffer.alloc((size*4+1)*size);for(let y=0;y<size;y++){raw[y*(size*4+1)]=0;for(let x=0;x<size;x++){const u=x/size,v=y/size;const r=0.22;const inRound=(()=>{const cx=Math.min(Math.max(u,r),1-r),cy=Math.min(Math.max(v,r),1-r);return (u-cx)**2+(v-cy)**2<=r*r;})();
let col=[0,0,0,0];if(inRound){col=[47,91,211,255];const inEnv=u>0.22&&u<0.78&&v>0.34&&v<0.69;const edge=inEnv&&(u<0.26||u>0.74||v<0.38||v>0.65);const diag=inEnv&&Math.abs((v-0.34)-0.62*Math.abs(u-0.5)*-1+ -0.31+0.31)<0.0;const flap=inEnv&&Math.abs(v-(0.34+0.6*(0.5-Math.abs(u-0.5))))<0.035;if(edge||flap||diag)col=[255,255,255,255];}
const o=y*(size*4+1)+1+x*4;raw[o]=col[0];raw[o+1]=col[1];raw[o+2]=col[2];raw[o+3]=col[3];}}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);}
for(const s of [192,512]) fs.writeFileSync(`public/icons/icon-${s}.png`,png(s));
console.log("icons written");
