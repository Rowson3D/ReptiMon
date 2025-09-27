// MicroPlot: tiny chart utility with hover + crosshair + tooltip
// API: const plot = new MicroPlot(canvas, { colors: ['#60a5fa','#9ca3af'], maxPoints: 240 });
//      plot.setData({ x: [timestamps...], series: [[t...],[h...]] });
(function(){
  class MicroPlot{
    constructor(canvas, opts={}){
      this.el = canvas; this.ctx = canvas.getContext('2d');
      this.colors = opts.colors || ['#60a5fa','#9ca3af'];
      this.maxPoints = opts.maxPoints || 240;
      this.data = { x: [], series: [] };
      this.hover = { i: -1, x: 0 }; this.pad = 8;
      this.tip = document.createElement('div');
      this.tip.className = 'chart-tip';
      canvas.parentElement?.appendChild(this.tip);
      this._bind(); this._resize(); this.draw();
    }
    _bind(){
      this._ro = new ResizeObserver(()=>{ this._resize(); this.draw(); });
      this._ro.observe(this.el);
      this.el.addEventListener('mousemove', (e)=>{
        const rect = this.el.getBoundingClientRect();
        const x = e.clientX - rect.left; this.hover.x = x; this.hover.i = this._nearestIndex(x); this.draw();
      });
      this.el.addEventListener('mouseleave', ()=>{ this.hover.i = -1; this.tip.style.display='none'; this.draw(); });
    }
    _resize(){
      const dpr = Math.max(1, window.devicePixelRatio||1);
      const cssW = this.el.clientWidth || 300; const cssH = this.el.clientHeight || 200;
      this.el.width = Math.floor(cssW * dpr); this.el.height = Math.floor(cssH * dpr);
      this.ctx.setTransform(dpr,0,0,dpr,0,0);
    }
    setData(d){
      this.data = d; if (this.data.x.length > this.maxPoints){
        const start = this.data.x.length - this.maxPoints;
        this.data = { x: this.data.x.slice(start), series: this.data.series.map(s=>s.slice(start)) };
      }
      this.draw();
    }
    _scales(){
      const {x, series} = this.data; const n = x.length; const w = this.el.clientWidth, h = this.el.clientHeight;
      const pad = this.pad; const xi = n>1 ? (w-2*pad)/(n-1) : 0; const xs = (i)=> pad + xi*i;
      const rng = (arr)=>[Math.min(...arr), Math.max(...arr)];
      const [tmin,tmax] = rng(series[0]||[0]); const [hmin,hmax] = rng(series[1]||[0]);
      const ymap = (v, vmin, vmax)=> h - pad - ((v - vmin)/Math.max(0.001,(vmax-vmin)))*(h-2*pad);
      return { pad, n, w, h, xs, yT: (v)=>ymap(v,tmin,tmax), yH: (v)=>ymap(v,hmin,hmax), tmin,tmax,hmin,hmax };
    }
    _nearestIndex(px){
      const {n, xs} = this._scales(); if (n<2) return -1;
      let best=-1, bd=1e9; for(let i=0;i<n;i++){ const dx=Math.abs(xs(i)-px); if(dx<bd){bd=dx;best=i;} }
      return best;
    }
    _fmtTime(ts){ const d=new Date(ts); return d.toLocaleTimeString(); }
    draw(){
      const {ctx} = this; const d = this.data; const n = d.x.length; const sc = this._scales();
      ctx.clearRect(0,0,sc.w,sc.h);
      // grid axes
      ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(sc.pad, sc.pad); ctx.lineTo(sc.pad, sc.h-sc.pad); ctx.lineTo(sc.w-sc.pad, sc.h-sc.pad); ctx.stroke();
      // series: temp
      if (d.series[0] && n>1){ ctx.strokeStyle=this.colors[0]; ctx.lineWidth=1.4; ctx.beginPath();
        for(let i=0;i<n;i++){ const x=sc.xs(i), y=sc.yT(d.series[0][i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y);} ctx.stroke(); }
      // series: hum
      if (d.series[1] && n>1){ ctx.strokeStyle=this.colors[1]; ctx.lineWidth=1.4; ctx.beginPath();
        for(let i=0;i<n;i++){ const x=sc.xs(i), y=sc.yH(d.series[1][i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y);} ctx.stroke(); }
      // crosshair + tooltip
      if (this.hover.i>=0 && n>this.hover.i){ const i=this.hover.i; const x=sc.xs(i);
        ctx.strokeStyle='rgba(255,255,255,.25)'; ctx.beginPath(); ctx.moveTo(x, sc.pad); ctx.lineTo(x, sc.h-sc.pad); ctx.stroke();
        // tip
        const tt = this.tip; tt.style.display='block'; tt.innerHTML = `<div>${this._fmtTime(d.x[i])}</div><div><span class="dot temp"></span>${(d.series[0]?.[i]??NaN).toFixed(1)}°</div><div><span class="dot hum"></span>${(d.series[1]?.[i]??NaN).toFixed(1)}%</div>`;
  const rect = this.el.getBoundingClientRect();
  const parentRect = this.el.parentElement.getBoundingClientRect();
  const relX = x + (rect.left - parentRect.left);
  tt.style.left = Math.max(8, Math.min(parentRect.width-tt.offsetWidth-8, relX+8))+'px';
  tt.style.top = '8px';
      }
    }
  }
  window.MicroPlot = MicroPlot;
})();
