'use strict';
// CPUの判断処理をゲーム本体から分離したモジュール。
// ゲーム状態の変更や弾の生成は、server.jsから渡された関数を通じて行う。
module.exports = function createCpuAI({ clamp, nearestEnemy, WEAPONS, WORLD_W, WORLD_H, shoot, blockedAt, fullyInsideAbyss, kill, tileAt }) {
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
function segmentHitsRect(x1,y1,x2,y2,o){
  // Liang-Barsky segment/rectangle intersection; endpoints inside a wall also count.
  let t0=0,t1=1; const dx=x2-x1,dy=y2-y1;
  const tests=[[-dx,x1-o.x],[dx,o.x+o.w-x1],[-dy,y1-o.y],[dy,o.y+o.h-y1]];
  for(const [p,q] of tests){if(Math.abs(p)<1e-9){if(q<0)return false;continue;}const r=q/p;if(p<0){if(r>t1)return false;if(r>t0)t0=r;}else{if(r<t0)return false;if(r<t1)t1=r;}}
  return t1>0.025&&t0<0.975;
}
function hasLineOfSight(g,p,q){return !(g.objects||[]).some(o=>o.type==='wall'&&segmentHitsRect(p.x,p.y,q.x,q.y,o));}
function groundAt(g,x,y){return typeof tileAt==='function'?tileAt(g,x,y):0;}
function nearestFriendlyGround(g,p,maxDistance=900){
  const step=36; let best=null,bestScore=Infinity;
  // Sample a coarse spiral around the CPU instead of scanning every tile each frame.
  for(let r=step;r<=maxDistance;r+=step){
    const n=Math.max(8,Math.ceil(2*Math.PI*r/step));
    for(let i=0;i<n;i++){
      const a=2*Math.PI*i/n,x=clamp(p.x+Math.cos(a)*r,p.r,WORLD_W-p.r),y=clamp(p.y+Math.sin(a)*r,p.r,WORLD_H-p.r);
      if(groundAt(g,x,y)!==p.team||blockedAt(g,x,y,p.r)||(g.objects||[]).some(o=>o.type==='abyss'&&x>=o.x&&x<=o.x+o.w&&y>=o.y&&y<=o.y+o.h))continue;
      let score=Math.hypot(x-p.x,y-p.y);
      // Prefer a friendly tile that is also sheltered from the current enemy.
      const enemy=nearestEnemy(g,p);
      if(enemy&& !hasLineOfSight(g,{x,y},enemy.p)) score-=75;
      if(score<bestScore){bestScore=score;best={x,y};}
    }
    if(best&&bestScore<r+step)break;
  }
  return best;
}
function chooseCoverPoint(g,p,enemy){
  let best=null,bestScore=-Infinity;
  for(let r=50;r<=230;r+=35){
    for(let i=0;i<16;i++){
      const a=i*Math.PI/8,x=clamp(p.x+Math.cos(a)*r,p.r,WORLD_W-p.r),y=clamp(p.y+Math.sin(a)*r,p.r,WORLD_H-p.r);
      if(blockedAt(g,x,y,p.r)||(g.objects||[]).some(o=>o.type==='abyss'&&x>=o.x&&x<=o.x+o.w&&y>=o.y&&y<=o.y+o.h))continue;
      const covered=enemy&&!hasLineOfSight(g,{x,y},enemy.p);
      const own=groundAt(g,x,y)===p.team;
      const score=(covered?170:0)+(own?100:0)-Math.hypot(x-p.x,y-p.y)*0.35-(groundAt(g,x,y)!==0&&groundAt(g,x,y)!==p.team?65:0);
      if(score>bestScore){bestScore=score;best={x,y,covered,own};}
    }
  }
  return best;
}

function chooseDeepFriendlyPoint(g,p,enemy,maxDistance=300){
  let best=null,bestScore=-Infinity;
  // Search nearby friendly tiles, preferring ground farther from the enemy/frontier.
  for(let r=60;r<=maxDistance;r+=30){
    for(let i=0;i<20;i++){
      const a=i*Math.PI/10;
      const x=clamp(p.x+Math.cos(a)*r,p.r,WORLD_W-p.r);
      const y=clamp(p.y+Math.sin(a)*r,p.r,WORLD_H-p.r);
      if(groundAt(g,x,y)!==p.team||blockedAt(g,x,y,p.r))continue;
      if((g.objects||[]).some(o=>o.type==='abyss'&&x>=o.x&&x<=o.x+o.w&&y>=o.y&&y<=o.y+o.h))continue;
      const enemyDistance=enemy?Math.hypot(x-enemy.p.x,y-enemy.p.y):0;
      const currentDistance=enemy?Math.hypot(p.x-enemy.p.x,p.y-enemy.p.y):0;
      const score=(enemy?Math.min(500,enemyDistance-currentDistance)*0.8:0)-r*0.18;
      if(score>bestScore){bestScore=score;best={x,y};}
    }
  }
  return best;
}

function choosePaintAngle(g,p,weapon){
  const maxDistance=Math.min(1100,Math.max(100,(weapon.speed||180)*0.45*(weapon.range||1)));
  let bestAngle=p.angle||0,bestScore=-Infinity;
  // Score rays by how much new territory they can paint, while avoiding walls/dry zones.
  for(let i=0;i<24;i++){
    const a=i*Math.PI/12; let score=0;
    for(let d=36;d<=maxDistance;d+=24){
      const x=p.x+Math.cos(a)*d,y=p.y+Math.sin(a)*d;
      if(x<0||y<0||x>WORLD_W||y>WORLD_H)break;
      if((g.objects||[]).some(o=>o.type==='wall'&&x>=o.x&&x<=o.x+o.w&&y>=o.y&&y<=o.y+o.h))break;
      if((g.objects||[]).some(o=>o.type==='dry'&&x>=o.x&&x<=o.x+o.w&&y>=o.y&&y<=o.y+o.h)){score-=2;continue;}
      const ground=groundAt(g,x,y);
      if(ground!==p.team)score+=ground===0?1.25:0.8;
      else score-=0.12;
    }
    // Small preference for not turning wildly every frame.
    const turn=Math.abs(Math.atan2(Math.sin(a-(p.angle||0)),Math.cos(a-(p.angle||0))));
    score-=turn*1.5;
    if(score>bestScore){bestScore=score;bestAngle=a;}
  }
  return {angle:bestAngle,score:bestScore,distance:maxDistance};
}

function fireAI(g,p,angle,dt,shouldFire){
  const weapon=WEAPONS[p.weaponId]||WEAPONS[0];
  if(!weapon.charge){
    p.aiCharging=false;
    p.aiChargeTime=0;
    if(shouldFire&&p.cooldown<=0&&p.shadow>=weapon.cost)shoot(g,p,angle,0);
    return;
  }
  const desiredCharge=Math.min(weapon.maxCharge||0.01, weapon.id==='weapon3'?0.45:0.01);
  if(shouldFire&&p.cooldown<=0&&p.shadow>weapon.cost){
    if(!p.aiCharging){p.aiCharging=true;p.aiChargeTime=0;}
    const drain=Math.min(p.shadow, (weapon.chargeCostPerSec||0)*dt);
    p.shadow=Math.max(0,p.shadow-drain);
    p.aiChargeTime=Math.min(weapon.maxCharge||desiredCharge,p.aiChargeTime+dt);
    if(p.aiChargeTime>=desiredCharge-1e-4){
      const charge=p.aiChargeTime;
      p.aiCharging=false;p.aiChargeTime=0;
      shoot(g,p,angle,charge);
    }
  }else if(p.aiCharging){
    const charge=p.aiChargeTime||0;
    p.aiCharging=false;p.aiChargeTime=0;
    if(charge>0&&p.cooldown<=0&&p.shadow>=weapon.cost)shoot(g,p,angle,charge);
  }
}

function aiStep(g,p,dt){
  if(!p.alive)return;
  const target=nearestEnemy(g,p); p.cooldown=Math.max(0,p.cooldown-dt); p.aiThink=Math.max(0,(p.aiThink||0)-dt);
  const speed=86+(p.shadow<30?8:0), weapon=WEAPONS[p.weaponId]||WEAPONS[0];
  const currentGround=groundAt(g,p.x,p.y), onEnemyGround=currentGround!==0&&currentGround!==p.team;
  let tx=0,ty=0, defensive=false;

  // Priority 1: survive, with hysteresis to prevent oscillation at the territory border.
  // Once retreat starts, stay in recovery mode until shadow is high again on friendly ground.
  if(!p.aiRecovering && ((onEnemyGround && p.shadow<78) || p.shadow<28)){
    p.aiRecovering=true;
    p.aiSafeGoal=null;
    p.aiRecoverGoal=null;
  }
  if(p.aiRecovering){
    if(!onEnemyGround && p.shadow>=88){
      p.aiRecovering=false;
      p.aiSafeGoal=null;
      p.aiRecoverGoal=null;
    }else{
      defensive=true;
      if(onEnemyGround){
        let safe=p.aiSafeGoal;
        if(!safe||p.aiThink<=0||Math.hypot(safe.x-p.x,safe.y-p.y)<38||groundAt(g,safe.x,safe.y)!==p.team){
          safe=nearestFriendlyGround(g,p,1100);
          if(safe)p.aiSafeGoal=safe;
          p.aiThink=0.55;
        }
        if(safe){tx=safe.x-p.x;ty=safe.y-p.y;}
      }else if(p.shadow<88){
        // After reaching friendly ground, back away from the frontier and recover there.
        let hold=p.aiRecoverGoal;
        if(!hold||p.aiThink<=0||Math.hypot(hold.x-p.x,hold.y-p.y)<32||groundAt(g,hold.x,hold.y)!==p.team){
          hold=chooseDeepFriendlyPoint(g,p,target,300);
          if(hold)p.aiRecoverGoal=hold;
          p.aiThink=0.65;
        }
        if(hold && Math.hypot(hold.x-p.x,hold.y-p.y)>28){tx=hold.x-p.x;ty=hold.y-p.y;}
        else {tx=0;ty=0;}
      }
    }
  }

  // Priority 2: hide behind walls while recovering. Do not keep exposing the CPU
  // to shoot through a wall; choose a waypoint with friendly ground/cover instead.
  if(!defensive&&target&&p.shadow<72){
    const q=target.p,visible=hasLineOfSight(g,p,q);
    if(!visible){
      // Already behind cover: move to friendly ground if nearby, otherwise hold position.
      const safe=nearestFriendlyGround(g,p,420);
      if(safe&&groundAt(g,p.x,p.y)!==p.team){tx=safe.x-p.x;ty=safe.y-p.y;defensive=true;}
      else {tx=0;ty=0;defensive=true;}
    }else if(p.shadow<48){
      const cover=chooseCoverPoint(g,p,q);
      if(cover&&cover.covered){tx=cover.x-p.x;ty=cover.y-p.y;defensive=true;}
    }
  }

  if(!defensive&&target){
    const q=target.p,dx=q.x-p.x,dy=q.y-p.y,d=target.d;
    const visible=hasLineOfSight(g,p,q),pred=predictIntercept(p,q,weapon),a=Math.atan2(dy,dx);
    const preferred=clamp((weapon.speed||180)*0.45*(weapon.range||1)*0.72,115,330);
    if(d>preferred+35){tx=dx;ty=dy;}
    else if(d<preferred-55){tx=-dx;ty=-dy;}
    else {tx=Math.cos(a+Math.PI/2*p.strafe)*0.9;ty=Math.sin(a+Math.PI/2*p.strafe)*0.9;}
    const threat=incomingBullet(g,p);
    if(threat){let ex=threat.dx,ey=threat.dy,el=Math.hypot(ex,ey)||1;ex/=el;ey/=el;tx=tx*0.25+(-ey*p.strafe)*1.25+ex*0.45;ty=ty*0.25+(ex*p.strafe)*1.25+ey*0.45;if(threat.t<0.16)p.strafe*=-1;}
    // If blocked by a wall, flank rather than repeatedly firing into it.
    if(!visible){const flank=chooseCoverPoint(g,p,q);if(flank){tx=(flank.x-p.x)*0.75+dx*0.15;ty=(flank.y-p.y)*0.75+dy*0.15;}}
    p.angle=Math.atan2(pred.y-p.y,pred.x-p.x);
    const maxDistance=(weapon.speed||180)*0.45*(weapon.range||1),predDistance=Math.hypot(pred.x-p.x,pred.y-p.y);
    const canAttack=visible&&predDistance<maxDistance*0.96&&p.shadow>=weapon.cost;
    if(canAttack){
      const jitter=(Math.random()-.5)*Math.min(0.11,0.035+predDistance*0.00012);
      fireAI(g,p,p.angle+jitter,dt,true);
    }else if(p.aiCharging){fireAI(g,p,p.angle,dt,false);}
  }else if(!target&&!defensive){
    if(!p.aiGoal||Math.hypot(p.aiGoal.x-p.x,p.aiGoal.y-p.y)<45||p.aiThink<=0){
      const midX=WORLD_W/2,midY=WORLD_H/2;
      p.aiGoal={x:clamp(midX+(Math.random()-.5)*300,p.r,WORLD_W-p.r),y:clamp(midY+(Math.random()-.5)*180,p.r,WORLD_H-p.r)};p.aiThink=0.7+Math.random()*0.5;
    }
    tx=p.aiGoal.x-p.x;ty=p.aiGoal.y-p.y;
  }

  // Territory-building is an explicit objective, not just a side effect of combat.
  // When there is no useful target, continuously choose the ray with the most unpainted ground.
  const paintCapable=(weapon.paintRadius||0)>=8;
  const combatDistance=(weapon.speed||180)*0.45*(weapon.range||1);
  if(paintCapable&&!defensive&&(!target||target.d>combatDistance*1.15)){
    const paint=choosePaintAngle(g,p,weapon);
    p.aiPaintAngle=paint.angle;
    // Walk toward the frontier while painting it, instead of standing in one spot.
    tx=Math.cos(paint.angle)*0.8+Math.cos(paint.angle+Math.PI/2*p.strafe)*0.35;
    ty=Math.sin(paint.angle)*0.8+Math.sin(paint.angle+Math.PI/2*p.strafe)*0.35;
    p.angle=paint.angle;
    if(p.shadow>=weapon.cost&&paint.score>0){fireAI(g,p,paint.angle,dt,true);}
  }

  // If a paint-capable weapon is equipped and the CPU is losing shadow on enemy
  // ground, fire a short defensive paint line back toward friendly territory.
  // The ordinary projectile paint mechanic is used; no free territory is granted.
  if(onEnemyGround&&p.shadow<70&&!weapon.charge&&(weapon.paintRadius||0)>=p.r+8&&p.cooldown<=0&&p.shadow>=weapon.cost){
    const safe=nearestFriendlyGround(g,p,600);
    if(safe){const a=Math.atan2(safe.y-p.y,safe.x-p.x);fireAI(g,p,a,dt,true);p.angle=a;}
  }

  if(p.aiCharging && !(paintCapable&&!defensive&&(!target||target.d>combatDistance*1.15)) && !(target&&!defensive&&target.d<=combatDistance)) fireAI(g,p,p.angle,dt,false);

  const len=Math.hypot(tx,ty);
  if(len>0.01){tx/=len;ty/=len;}else{tx=0;ty=0;}
  const nx=clamp(p.x+tx*speed*dt,p.r,WORLD_W-p.r),ny=clamp(p.y+ty*speed*dt,p.r,WORLD_H-p.r);
  if(!blockedAt(g,nx,p.y,p.r))p.x=nx;else p.strafe*=-1;
  if(!blockedAt(g,p.x,ny,p.r))p.y=ny;else p.strafe*=-1;
  if(fullyInsideAbyss(g,p))kill(g,p,null);
}
  function recordHistory(g, tick) {
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
