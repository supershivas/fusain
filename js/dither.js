// Matrices de seuil de Bayer (tramage ordonné), partagées par Pixelliser, Dégradé et Tramage.
// Module sans dépendance : il peut être importé depuis n'importe où sans souci de cycle.
export const BAYER4=[[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
export const BAYER8=(()=>{ const m=[[0,2],[3,1]]; let n=2, cur=m;
  while(n<8){ const nn=n*2, nx=[]; for(let y=0;y<nn;y++){ nx.push([]); for(let x=0;x<nn;x++){
      nx[y].push(4*cur[y%n][x%n]+m[(y/n)|0][(x/n)|0]); } } cur=nx; n=nn; }
  return cur; })();
