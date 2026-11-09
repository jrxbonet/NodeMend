// Renders the app icon (broom on a rounded navy plate) to icon.png via a hidden window.
// Then: node scripts/png2ico.js icon.png icon.ico
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas id=c width=256 height=256></canvas>');
  const dataUrl = await win.webContents.executeJavaScript(`(function(){
    const c=document.getElementById('c'),x=c.getContext('2d');
    const rr=(X,Y,W,H,R)=>{x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+W,Y,X+W,Y+H,R);x.arcTo(X+W,Y+H,X,Y+H,R);x.arcTo(X,Y+H,X,Y,R);x.arcTo(X,Y,X+W,Y,R);x.closePath();};
    const g=x.createLinearGradient(0,0,256,256);g.addColorStop(0,'#1e3a8a');g.addColorStop(1,'#0b1220');
    rr(8,8,240,240,52);x.fillStyle=g;x.fill();x.lineWidth=6;x.strokeStyle='#38bdf8';x.stroke();
    // sparkle
    x.fillStyle='#fbbf24';[[70,60,9],[52,96,5],[96,44,5]].forEach(([px,py,r])=>{x.beginPath();for(let i=0;i<8;i++){const a=i*Math.PI/4,d=i%2?r*0.4:r;x.lineTo(px+Math.cos(a)*d,py+Math.sin(a)*d);}x.closePath();x.fill();});
    // handle
    x.save();x.translate(128,128);x.rotate(-Math.PI/4);
    rr(-14,-120,28,140,10);x.fillStyle='#d97706';x.fill();rr(-14,-120,28,20,8);x.fillStyle='#fbbf24';x.fill();
    // brush head
    rr(-46,10,92,34,10);x.fillStyle='#38bdf8';x.fill();
    x.fillStyle='#0ea5e9';for(let i=0;i<7;i++){rr(-44+i*13,40,10,52,4);x.fill();}
    x.fillStyle='#7dd3fc';for(let i=0;i<7;i++){rr(-44+i*13,40,10,14,3);x.fill();}
    x.restore();
    return c.toDataURL('image/png');
  })()`);
  fs.writeFileSync('icon.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('icon.png written');
  app.exit(0);
});
