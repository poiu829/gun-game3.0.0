'use strict';
// CPUの判断処理をゲーム本体から分離したモジュール。
// ゲーム状態の変更や弾の生成は、server.jsから渡された関数を通じて行う。
module.exports = function createCpuAI({ clamp, nearestEnemy, WEAPONS, WORLD_W, WORLD_H, shoot, blockedAt, fullyInsideAbyss, kill }) {
function estimateVelocity(q,now){
  const h=q.aiHistory||[]; if(h.length<2)return {vx:0,vy:0};
  const newest=h[h.length-1]; let old=h[0];
  for(const item of h){if(newest.t-item.t>=0.22){old=item;break;}}
  const span=newest.t-old.t; if(span<0.08)return {vx:0,vy:0};
  return {vx:clamp((newest.x-old.x)/span,-180,180),vy:clamp((newest.y-old.y)/span,-180,180)};
}
function predictIntercept(p,q,weapon){
  const v=estimateVelocity(q,0), dx=q.x-p.x,dy=q.y-p.y;
  const speed=Math.max(1,weapon.speed||180);
  // Iterate travel time because target motion and projectile travel depend on one another.
  let t=Math.hypot(dx,dy)/speed;
  for(let i=0;i<3;i++){
    const px=q.x+v.vx*t,py=q.y+v.vy*t;
    t=Math.min(weapon.range*0.45,Math.hypot(px-p.x,py-p.y)/speed);
  }
  const maxT=Math.max(0.08,(weapon.range||1)*0.45);
  t=Math.min(t,maxT);
  return {x:q.x+v.vx*t,y:q.y+v.vy*t,vx:v.vx,vy:v.vy,t};
}
function incomingBullet(g,p){
  let best=null,bestTime=Infinity;
  for(const b of g.bullets){
    if(b.team===p.team||b.ownerId===p.id)continue;
    const vx=b.vx,vy=b.vy, vv=vx*vx+vy*vy; if(vv<1)continue;
    const rx=p.x-b.x,ry=p.y-b.y;
    const t=clamp((rx*vx+ry*vy)/vv,0,0.48);
    const bx=b.x+vx*t,by=b.y+vy*t,dist=Math.hypot(p.x-bx,p.y-by);
    if(dist<p.r+(b.r||8)+24&&t<bestTime){best={t,dx:p.x-bx,dy:p.y-by,dist};bestTime=t;}
  }
  return best;
}
// 複数の移動候補を短時間だけ先読みし、安全性と戦略上の有利さを比較する。
// 本格的な強化学習を追加する前の、軽量な探索型判断。
function chooseMovement(g,p,target,desiredX,desiredY,speed,preferred){
  const desiredLen=Math.hypot(desiredX,desiredY)||1;
  desiredX/=desiredLen; desiredY/=desiredLen;
  const dirs=[
    [desiredX,desiredY],[1,0],[-1,0],[0,1],[0,-1],
    [0.707,0.707],[0.707,-0.707],[-0.707,0.707],[-0.707,-0.707],[0,0]
  ];
  const horizon=0.32;
  let best={x:desiredX,y:desiredY,score:-Infinity};
  for(const dir of dirs){
    const dl=Math.hypot(dir[0],dir[1])||1, mx=dir[0]/dl,my=dir[1]/dl;
    const x=clamp(p.x+mx*speed*horizon,p.r,WORLD_W-p.r);
    const y=clamp(p.y+my*speed*horizon,p.r,WORLD_H-p.r);
    if(blockedAt(g,x,y,p.r))continue;
    let score=(mx*desiredX+my*desiredY)*1.7;
    // 目標がいるときは、武器に合った距離を維持できる候補を評価する。
    if(target){
      const q=target.p, d=Math.hypot(q.x-x,q.y-y);
      score-=Math.abs(d-preferred)/Math.max(100,preferred)*1.25;
      if(d<p.r+q.r+12)score-=1.5;
    }
    // 予測区間内に弾が近づく候補には大きなペナルティを与える。
    for(const b of g.bullets){
      if(b.team===p.team||b.ownerId===p.id)continue;
      const bx=b.x+b.vx*horizon, by=b.y+b.vy*horizon;
      const dist=Math.hypot(x-bx,y-by), danger=p.r+(b.r||8)+18;
      if(dist<danger)score-=((danger-dist)/danger)*2.8;
    }
    // 同点なら、前フレームからの急な方向転換を少し避ける。
    if(p.aiMoveX!==undefined)score+=(mx*p.aiMoveX+my*p.aiMoveY)*0.12;
    if(score>best.score)best={x:mx,y:my,score};
  }
  p.aiMoveX=best.x; p.aiMoveY=best.y;
  return {x:best.x,y:best.y};
}
function aiStep(g,p,dt){
  if(!p.alive)return;
  const target=nearestEnemy(g,p); p.cooldown=Math.max(0,p.cooldown-dt); p.aiThink=Math.max(0,(p.aiThink||0)-dt);
  const speed=86+(p.shadow<30?8:0);
  let tx=0,ty=0;
  if(!target){
    // Remember a destination briefly instead of recalculating a random decision every frame.
    if(!p.aiGoal||Math.hypot(p.aiGoal.x-p.x,p.aiGoal.y-p.y)<45||p.aiThink<=0){
      const midX=WORLD_W/2,midY=WORLD_H/2;
      p.aiGoal={x:clamp(midX+(Math.random()-.5)*300,p.r,WORLD_W-p.r),y:clamp(midY+(Math.random()-.5)*180,p.r,WORLD_H-p.r)};
      p.aiThink=0.7+Math.random()*0.5;
    }
    tx=p.aiGoal.x-p.x;ty=p.aiGoal.y-p.y;
  }else{
    const q=target.p,dx=q.x-p.x,dy=q.y-p.y,d=target.d;
    const weapon=WEAPONS[p.weaponId]||WEAPONS[0];
    const pred=predictIntercept(p,q,weapon);
    const a=Math.atan2(dy,dx);
    // Pick a useful range for the equipped weapon; circle/strafe instead of charging straight in.
    const preferred=clamp((weapon.speed||180)*0.45*(weapon.range||1)*0.72,115,330);
    if(d>preferred+35){tx=dx;ty=dy;}
    else if(d<preferred-55){tx=-dx;ty=-dy;}
    else {tx=Math.cos(a+Math.PI/2*p.strafe)*0.9;ty=Math.sin(a+Math.PI/2*p.strafe)*0.9;}
    // Dodge a bullet only when its projected path is actually threatening.
    const threat=incomingBullet(g,p);
    if(threat){
      let ex=threat.dx,ey=threat.dy,el=Math.hypot(ex,ey)||1;ex/=el;ey/=el;
      // Combine a strong sidestep with a small move away from the predicted impact point.
      const side=p.strafe;
      tx=tx*0.25+(-ey*side)*1.25+ex*0.45;
      ty=ty*0.25+(ex*side)*1.25+ey*0.45;
      if(threat.t<0.16)p.strafe*=-1;
    }
    // Keep the aim based on the target's recent movement, not just its current location.
    const aimAngle=Math.atan2(pred.y-p.y,pred.x-p.x); p.angle=aimAngle;
    const maxDistance=(weapon.speed||180)*0.45*(weapon.range||1);
    const predDistance=Math.hypot(pred.x-p.x,pred.y-p.y);
    if(predDistance<maxDistance*0.96&&p.cooldown<=0&&p.shadow>=weapon.cost){
      const jitter=(Math.random()-.5)*Math.min(0.11,0.035+predDistance*0.00012);
      shoot(g,p,aimAngle+jitter,0,pred.x,pred.y);
    }
  }
  // 戦略が示した方向を基準に、複数の移動候補を短時間先読みして選ぶ。
  const weapon=target?(WEAPONS[p.weaponId]||WEAPONS[0]):null;
  const preferred=weapon?clamp((weapon.speed||180)*0.45*(weapon.range||1)*0.72,115,330):200;
  const chosen=chooseMovement(g,p,target,tx,ty,speed,preferred);
  tx=chosen.x;ty=chosen.y;
  const nx=clamp(p.x+tx*speed*dt,p.r,WORLD_W-p.r),ny=clamp(p.y+ty*speed*dt,p.r,WORLD_H-p.r);
  if(!blockedAt(g,nx,p.y,p.r))p.x=nx;else p.strafe*=-1;
  if(!blockedAt(g,p.x,ny,p.r))p.y=ny;else p.strafe*=-1;
  if(fullyInsideAbyss(g,p))kill(g,p,null);
}  function recordHistory(g, tick) {
    if (tick % 3 !== 0) return;
    const now = tick / 30;
    for (const q of g.players) {
      if (!q.alive) continue;
      if (!q.aiHistory) q.aiHistory = [];
      q.aiHistory.push({ x: q.x, y: q.y, t: now });
      while (q.aiHistory.length > 7 || (q.aiHistory.length > 2 && now - q.aiHistory[0].t > 0.65)) q.aiHistory.shift();
    }
  }
  return { aiStep, recordHistory };
};
