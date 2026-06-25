"use strict";

const $ = id => document.getElementById(id);
const els = {
  kpiCards:$('kpiCards'), mergeMode:$('mergeMode'), yearPicker:$('yearPicker'), yearSummary:$('yearSummary'),
  regionSelect:$('regionSelect'), citySelect:$('citySelect'), topN:$('topN'), searchInput:$('searchInput'),
  schoolSelect:$('schoolSelect'), schoolDetail:$('schoolDetail'), adviceList:$('adviceList'), dataTable:$('dataTable'),
  tableCount:$('tableCount'), rankScope:$('rankScope'), yearChartTitle:$('yearChartTitle'), yearChartScope:$('yearChartScope'),
  aliasList:$('aliasList'), qualitySummary:$('qualitySummary'), toast:$('toast')
};
const chartRefs = {};
const aliasLookup = new Map(ALIAS_GROUPS.flatMap(group => group.names.map(name => [name, group.standardName])));
const NON_SCHOOL_NAMES = new Set(['高級中等教育階段非學校型態實驗教育']);

// 快取與局部更新狀態：避免每次操作都重建所有圖表與完整資料表。
let aggregateCacheMode = null;
let aggregateCacheRows = null;
let filterCacheKey = null;
let filterCacheRows = null;
let periodCache = null;
let renderFrame = null;
let searchTimer = null;
let fastRender = false;

function esc(value){return String(value ?? '').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));}
function num(value){const n=Number(value);return Number.isFinite(n)?n:0;}
function fmt(value){return num(value).toLocaleString('zh-TW');}
function percent(value,total){return total?(value/total*100).toFixed(2)+'%':'0.00%';}
function showToast(message){els.toast.textContent=message;els.toast.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>els.toast.classList.remove('show'),2400);}
function yearOptionNodes(){return [...document.querySelectorAll('input[name="yearOption"]')];}

function selectedPeriod(){
  if(periodCache) return periodCache;
  const checked=yearOptionNodes().filter(input=>input.checked).map(input=>input.value);
  if(checked.includes('total')||checked.length===0){
    periodCache={mode:'total',years:[...YEARS],label:'五年總計',summary:'五年總計'};
    return periodCache;
  }
  const years=YEARS.filter(year=>checked.includes(year));
  const label=years.length===1?`${years[0]}學年度`:`${years.join('、')}學年度合計`;
  periodCache={mode:'years',years,label,summary:years.join('、')};
  return periodCache;
}

function invalidatePeriodCache(){periodCache=null;}
function invalidateFilterCache(){filterCacheKey=null;filterCacheRows=null;}
function invalidateAggregateCache(){aggregateCacheMode=null;aggregateCacheRows=null;invalidateFilterCache();}

function updateYearSummary(){els.yearSummary.textContent=selectedPeriod().summary;}

function handleYearOptionChange(changed){
  const nodes=yearOptionNodes();
  if(changed.value==='total'&&changed.checked){
    nodes.filter(input=>input.value!=='total').forEach(input=>input.checked=false);
  }else if(changed.value!=='total'&&changed.checked){
    const total=nodes.find(input=>input.value==='total');
    if(total) total.checked=false;
  }
  if(!nodes.some(input=>input.checked)) changed.checked=true;
  invalidatePeriodCache();
  updateYearSummary();
  scheduleRender({updateKpis:true});
}

function resetYearOptions(){
  yearOptionNodes().forEach(input=>input.checked=input.value==='total');
  invalidatePeriodCache();
  updateYearSummary();
}

function detectLocation(rawName){
  if(!rawName) return {city:'未辨識',region:'未辨識'};
  if(NON_SCHOOL_NAMES.has(rawName)) return {city:'未辨識',region:'未辨識'};
  if(SCHOOL_LOCATION_OVERRIDES[rawName]) return SCHOOL_LOCATION_OVERRIDES[rawName];
  for(const [key,city,region] of CITY_RULES){if(rawName.includes(key)) return {city,region};}
  for(const [key,city,region] of [...PLACE_RULES].sort((a,b)=>b[0].length-a[0].length)){if(rawName.includes(key)) return {city,region};}
  if(/東莞|大陸/.test(rawName)) return {city:'海外／大陸',region:'其他'};
  if(/越南|胡志明|泰國/.test(rawName)) return {city:'海外／國外',region:'其他'};
  return {city:'未辨識',region:'未辨識'};
}

function parseRows(){
  return SCHOOL_TSV.trimEnd().split('\n').slice(1).map((line,index)=>{
    const parts=line.split('\t');
    const rawName=(parts[0]??'').trim();
    const displayName=rawName||'（原始空白校名）';
    const recordType=!rawName?'blank':NON_SCHOOL_NAMES.has(rawName)?'nonSchool':'school';
    const values=Object.fromEntries(YEARS.map((year,i)=>[year,num(parts[i+1])]));
    const calculated=YEARS.reduce((sum,year)=>sum+values[year],0);
    const total=parts[6]===''||parts[6]===undefined?calculated:num(parts[6]);
    const location=detectLocation(rawName);
    return {id:index+1,rawName,displayName,recordType,standardName:aliasLookup.get(rawName)||displayName,...location,...values,total,calculated};
  });
}
const rawRows=parseRows();

function aggregateRows(){
  const mode=els.mergeMode.value;
  if(aggregateCacheRows&&aggregateCacheMode===mode) return aggregateCacheRows;
  const merge=mode==='merged';
  const map=new Map();
  for(const row of rawRows){
    const key=merge?row.standardName:row.displayName;
    if(!map.has(key)) map.set(key,{name:key,rawNames:new Set(),recordTypes:new Set(),city:row.city,region:row.region,...Object.fromEntries(YEARS.map(y=>[y,0])),total:0});
    const target=map.get(key);
    target.rawNames.add(row.displayName);
    target.recordTypes.add(row.recordType);
    YEARS.forEach(year=>target[year]+=row[year]);
    target.total+=row.total;
    if(target.city==='未辨識'&&row.city!=='未辨識'){target.city=row.city;target.region=row.region;}
  }
  aggregateCacheMode=mode;
  aggregateCacheRows=[...map.values()].map(row=>({
    ...row,
    rawNames:[...row.rawNames],
    recordTypes:[...row.recordTypes],
    isSchool:row.recordTypes.has('school'),
    change:row['114']-row['110'],
    average:row.total/YEARS.length,
    trend:getTrend(row)
  }));
  return aggregateCacheRows;
}

function getTrend(row){
  const vals=YEARS.map(y=>row[y]);
  const diffs=vals.slice(1).map((v,i)=>v-vals[i]);
  const nonDecreasing=diffs.every(d=>d>=0)&&diffs.some(d=>d>0);
  const nonIncreasing=diffs.every(d=>d<=0)&&diffs.some(d=>d<0);
  if(nonDecreasing) return {label:'穩定成長',className:'trend-up'};
  if(nonIncreasing) return {label:'持續下降',className:'trend-down'};
  const range=Math.max(...vals)-Math.min(...vals);
  const avg=vals.reduce((a,b)=>a+b,0)/vals.length;
  if(range<=Math.max(2,avg*.18)) return {label:'大致穩定',className:'trend-stable'};
  return {label:'波動較大',className:'trend-volatile'};
}

function currentValue(row){
  const period=selectedPeriod();
  return period.mode==='total'?row.total:period.years.reduce((sum,year)=>sum+row[year],0);
}

function filteredRows(){
  const region=els.regionSelect.value,city=els.citySelect.value,query=els.searchInput.value.trim().toLocaleLowerCase('zh-Hant');
  const key=[els.mergeMode.value,region,city,query].join('||');
  if(filterCacheRows&&filterCacheKey===key) return filterCacheRows;
  let rows=aggregateRows();
  if(region!=='all') rows=rows.filter(r=>r.region===region);
  if(city!=='all') rows=rows.filter(r=>r.city===city);
  if(query) rows=rows.filter(r=>r.name.toLocaleLowerCase('zh-Hant').includes(query)||r.rawNames.join(' ').toLocaleLowerCase('zh-Hant').includes(query));
  filterCacheKey=key;
  filterCacheRows=rows;
  return rows;
}

function schoolRows(rows=filteredRows()){return rows.filter(row=>row.isSchool);}
function topRows(rows){const sorted=[...rows].sort((a,b)=>currentValue(b)-currentValue(a)||a.name.localeCompare(b.name,'zh-Hant'));return els.topN.value==='all'?sorted:sorted.slice(0,num(els.topN.value));}

function filterScopeText(){
  const parts=[];
  if(els.regionSelect.value!=='all') parts.push(els.regionSelect.value);
  if(els.citySelect.value!=='all') parts.push(els.citySelect.value);
  const query=els.searchInput.value.trim();
  if(query) parts.push(`搜尋「${query}」`);
  return parts.length?parts.join('｜'):'全部資料';
}

function refreshFilterOptions(){
  const rows=aggregateRows();
  const oldRegion=els.regionSelect.value||'all';
  const regions=[...new Set(rows.map(r=>r.region))].sort((a,b)=>a.localeCompare(b,'zh-Hant'));
  els.regionSelect.innerHTML='<option value="all">全部區域</option>'+regions.map(r=>`<option value="${esc(r)}">${esc(r)}</option>`).join('');
  els.regionSelect.value=regions.includes(oldRegion)?oldRegion:'all';
  const oldCity=els.citySelect.value||'all';
  const cities=[...new Set(rows.filter(r=>els.regionSelect.value==='all'||r.region===els.regionSelect.value).map(r=>r.city))].sort((a,b)=>a.localeCompare(b,'zh-Hant'));
  els.citySelect.innerHTML='<option value="all">全部縣市</option>'+cities.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  els.citySelect.value=cities.includes(oldCity)?oldCity:'all';
}

function chart(id,config){
  // 同一張圖只更新資料，不重建 Canvas；篩選操作時關閉動畫以減少卡頓。
  config.options={...(config.options||{}),animation:fastRender?false:(config.options?.animation??{duration:260})};
  const existing=chartRefs[id];
  if(existing&&existing.config.type===config.type){
    existing.data=config.data;
    existing.options=config.options;
    existing.update(fastRender?'none':undefined);
    return existing;
  }
  if(existing) existing.destroy();
  chartRefs[id]=new Chart($(id),config);
  return chartRefs[id];
}
function tooltipValue(ctx){
  if(ctx.chart?.options?.indexAxis==='y'&&typeof ctx.parsed?.x==='number') return ctx.parsed.x;
  if(typeof ctx.parsed?.y==='number') return ctx.parsed.y;
  if(typeof ctx.parsed?.x==='number') return ctx.parsed.x;
  if(typeof ctx.parsed==='number') return ctx.parsed;
  return num(ctx.raw);
}
function baseOptions(extra={}){
  const base={responsive:true,maintainAspectRatio:false,animation:{duration:260},plugins:{legend:{position:'bottom',labels:{usePointStyle:true}},tooltip:{callbacks:{label(ctx){const value=tooltipValue(ctx);return `${ctx.dataset.label||ctx.label}：${fmt(value)} 人`;}}}}};
  return {...base,...extra,plugins:{...base.plugins,...(extra.plugins||{})}};
}

function renderKPIs(){
  const all=filteredRows(),rows=schoolRows(all),period=selectedPeriod();
  const total=all.reduce((s,r)=>s+currentValue(r),0);
  const sorted=[...rows].sort((a,b)=>currentValue(b)-currentValue(a));
  const top=sorted[0];
  const top10=sorted.slice(0,10).reduce((s,r)=>s+currentValue(r),0);
  els.kpiCards.innerHTML=`
    <article class="card kpi-card"><div class="kpi-label">${esc(period.label)}篩選人數</div><div class="kpi-value">${fmt(total)}</div><div class="kpi-note">範圍：${esc(filterScopeText())}</div></article>
    <article class="card kpi-card"><div class="kpi-label">生源學校數</div><div class="kpi-value">${fmt(rows.length)}</div><div class="kpi-note">不把空白名稱與非學校型態資料計為學校</div></article>
    <article class="card kpi-card"><div class="kpi-label">最大生源學校</div><div class="kpi-value name">${esc(top?.name||'-')}</div><div class="kpi-note">${fmt(top?currentValue(top):0)}人，占目前篩選${percent(top?currentValue(top):0,total)}</div></article>
    <article class="card kpi-card"><div class="kpi-label">Top 10生源占比</div><div class="kpi-value">${percent(top10,total)}</div><div class="kpi-note">依${esc(period.label)}與目前條件計算</div></article>`;
}

function renderYearChart(){
  const rows=filteredRows(),period=selectedPeriod();
  const years=period.mode==='total'?[...YEARS]:period.years;
  const values=years.map(year=>rows.reduce((sum,row)=>sum+row[year],0));
  const scope=filterScopeText();
  els.yearChartTitle.textContent=period.mode==='total'?'目前篩選五年生源趨勢':'所選學年度生源趨勢';
  els.yearChartScope.textContent=`${scope}｜${rows.length}筆資料`;
  chart('yearChart',{
    type:'line',
    data:{labels:years.map(y=>`${y}學年度`),datasets:[{label:`${scope}生源人數`,data:values,borderColor:'#1f5eb8',backgroundColor:'rgba(31,94,184,.12)',fill:true,tension:.28,pointRadius:5,pointHoverRadius:7}]},
    options:baseOptions({scales:{y:{beginAtZero:true,ticks:{precision:0}}}})
  });
}

function renderAdvice(){
  const all=filteredRows(),rows=schoolRows(all),total=all.reduce((s,r)=>s+currentValue(r),0),sorted=[...rows].sort((a,b)=>currentValue(b)-currentValue(a));
  const top=sorted[0],top10=sorted.slice(0,10).reduce((s,r)=>s+currentValue(r),0);
  els.adviceList.innerHTML=sorted.length?`
    <div class="insight"><h3>核心生源：${esc(top.name)}</h3><p>${fmt(currentValue(top))}人，占目前篩選${percent(currentValue(top),total)}。適合優先維持既有關係。</p></div>
    <div class="insight"><h3>生源集中度</h3><p>前10所學校合計占${percent(top10,total)}；可用來評估主要來源流失的風險。</p></div>`:
    '<div class="insight"><h3>目前沒有符合條件的學校</h3><p>請調整區域、縣市或搜尋條件。</p></div>';
}

function renderRanking(){
  const all=schoolRows(),rows=topRows(all),total=all.reduce((s,r)=>s+currentValue(r),0),label=selectedPeriod().label;
  els.rankScope.textContent=`${label}｜${rows.length}所`;
  const height=Math.max(420,rows.length*27+90);$('rankChart').parentElement.style.height=`${Math.min(height,2400)}px`;
  chart('rankChart',{type:'bar',data:{labels:rows.map(r=>r.name),datasets:[{label,data:rows.map(currentValue),backgroundColor:'rgba(31,94,184,.78)',borderColor:'#1f5eb8',borderWidth:1,borderRadius:5}]},options:baseOptions({indexAxis:'y',scales:{x:{beginAtZero:true,ticks:{precision:0}},y:{ticks:{autoSkip:false}}},plugins:{legend:{display:false},tooltip:{callbacks:{label(ctx){const value=ctx.parsed.x;return `${fmt(value)}人，占目前篩選${percent(value,total)}`;}}}}})});
}

function renderSchoolOptions(){
  const rows=[...schoolRows()].sort((a,b)=>currentValue(b)-currentValue(a));
  const old=els.schoolSelect.value;
  els.schoolSelect.innerHTML=rows.map(r=>`<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('');
  if(rows.some(r=>r.name===old)) els.schoolSelect.value=old;
}

function renderSchool(){
  const rows=schoolRows();
  const row=rows.find(r=>r.name===els.schoolSelect.value)||[...rows].sort((a,b)=>currentValue(b)-currentValue(a))[0];
  if(!row){
    chart('schoolChart',{type:'line',data:{labels:[],datasets:[{label:'沒有符合條件的學校',data:[]}]},options:baseOptions({scales:{y:{beginAtZero:true}}})});
    els.schoolDetail.innerHTML='<p class="section-kicker">學校摘要</p><h2 class="school-name">沒有符合條件的學校</h2><p class="footnote">請調整區域、縣市或搜尋條件。</p>';
    return;
  }
  const period=selectedPeriod(),years=period.mode==='total'?[...YEARS]:period.years;
  chart('schoolChart',{type:'line',data:{labels:years.map(y=>`${y}學年度`),datasets:[{label:row.name,data:years.map(y=>row[y]),borderColor:'#1f5eb8',backgroundColor:'rgba(31,94,184,.1)',fill:true,tension:.28,pointRadius:5,pointHoverRadius:7}]},options:baseOptions({scales:{y:{beginAtZero:true,ticks:{precision:0}}}})});
  const peak=years.reduce((best,y)=>row[y]>row[best]?y:best,years[0]);
  const selectedTotal=years.reduce((sum,year)=>sum+row[year],0);
  els.schoolDetail.innerHTML=`<p class="section-kicker">學校摘要</p><h2 class="school-name">${esc(row.name)}</h2><div class="school-meta"><span class="badge">${esc(row.region)}</span><span class="badge">${esc(row.city)}</span><span class="trend-badge ${row.trend.className}">${row.trend.label}</span></div>
  <div class="metric-grid"><div class="metric"><span>${esc(period.mode==='total'?'五年總計':'所選年度合計')}</span><strong>${fmt(selectedTotal)}人</strong></div><div class="metric"><span>所選年度平均</span><strong>${(selectedTotal/years.length).toFixed(1)}人</strong></div><div class="metric"><span>所選期間最高</span><strong>${peak}｜${fmt(row[peak])}人</strong></div><div class="metric"><span>110→114</span><strong>${row.change>=0?'+':''}${fmt(row.change)}人</strong></div></div>
  <p class="footnote">原始名稱：${row.rawNames.map(esc).join('、')}</p>`;
}

function renderLocation(){
  const rows=filteredRows(),byCity=new Map(),byRegion=new Map();
  rows.forEach(r=>{byCity.set(r.city,(byCity.get(r.city)||0)+currentValue(r));byRegion.set(r.region,(byRegion.get(r.region)||0)+currentValue(r));});
  const cities=[...byCity.entries()].sort((a,b)=>b[1]-a[1]),regions=[...byRegion.entries()].sort((a,b)=>b[1]-a[1]);
  $('cityChart').parentElement.style.height=`${Math.max(420,cities.length*29+80)}px`;
  chart('cityChart',{type:'bar',data:{labels:cities.map(x=>x[0]),datasets:[{label:selectedPeriod().label,data:cities.map(x=>x[1]),backgroundColor:'rgba(31,94,184,.78)',borderRadius:5}]},options:baseOptions({indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{precision:0}},y:{ticks:{autoSkip:false}}}})});
  chart('regionChart',{type:'doughnut',data:{labels:regions.map(x=>x[0]),datasets:[{label:selectedPeriod().label,data:regions.map(x=>x[1]),backgroundColor:['#1f5eb8','#5f8fd0','#66a38f','#d09a45','#8871b6','#9aa4b2']}]},options:baseOptions({cutout:'58%'})});
}

function renderChange(){
  const rows=schoolRows().filter(r=>r.total>0),growth=[...rows].sort((a,b)=>b.change-a.change).filter(r=>r.change>0).slice(0,15),decline=[...rows].sort((a,b)=>a.change-b.change).filter(r=>r.change<0).slice(0,15);
  const common=(data,color)=>({type:'bar',data:{labels:data.map(r=>r.name),datasets:[{label:'110→114',data:data.map(r=>r.change),backgroundColor:color,borderRadius:5}]},options:baseOptions({indexAxis:'y',plugins:{legend:{display:false},tooltip:{callbacks:{label(ctx){const v=ctx.parsed.x;return `110→114：${v>=0?'+':''}${fmt(v)}人`;}}}},scales:{x:{ticks:{precision:0}},y:{ticks:{autoSkip:false}}}})});
  chart('growthChart',common(growth,'rgba(20,122,66,.78)'));chart('declineChart',common(decline,'rgba(180,35,24,.76)'));
}

function renderTable(){
  const rows=[...filteredRows()].sort((a,b)=>currentValue(b)-currentValue(a)||a.name.localeCompare(b.name,'zh-Hant'));
  els.tableCount.textContent=`${fmt(rows.length)}筆｜排序依${selectedPeriod().label}`;
  const showRaw=els.mergeMode.value==='merged';
  els.dataTable.innerHTML=`<thead><tr><th>學校／資料名稱</th><th>區域</th><th>縣市</th>${YEARS.map(y=>`<th>${y}</th>`).join('')}<th>總計</th>${showRaw?'<th>原始名稱</th>':''}</tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.region)}</td><td>${esc(r.city)}</td>${YEARS.map(y=>`<td>${fmt(r[y])}</td>`).join('')}<td><strong>${fmt(r.total)}</strong></td>${showRaw?`<td class="raw-names">${r.rawNames.map(esc).join('、')}</td>`:''}</tr>`).join('')}</tbody>`;
}

function renderQuality(){
  els.aliasList.innerHTML=ALIAS_GROUPS.map(group=>`<div class="quality-item"><h3>${esc(group.standardName)}</h3><p>${group.names.map(esc).join(' ＋ ')}</p></div>`).join('');
  const mismatches=rawRows.filter(r=>r.total!==r.calculated);
  const blankRows=rawRows.filter(r=>r.recordType==='blank');
  const nonSchoolRows=rawRows.filter(r=>r.recordType==='nonSchool');
  const yearChecks=YEARS.map(y=>({year:y,actual:rawRows.reduce((s,r)=>s+r[y],0),expected:EXPECTED_YEAR_TOTALS[y]}));
  const total=rawRows.reduce((s,r)=>s+r.total,0),allYearsOk=yearChecks.every(x=>x.actual===x.expected);
  els.qualitySummary.innerHTML=`
    <div class="quality-item"><h3>總計驗算</h3><p>${fmt(total)}人／預期${fmt(EXPECTED_TOTAL)}人：${total===EXPECTED_TOTAL?'一致':'不一致'}</p></div>
    <div class="quality-item"><h3>年度驗算</h3><p>${allYearsOk?'110～114各年度均與提供總計一致':'存在年度總計差異'}</p></div>
    <div class="quality-item"><h3>列總計驗算</h3><p>${mismatches.length===0?'每列五年加總均等於列總計':`${mismatches.length}列需要檢查`}</p></div>
    <div class="quality-item"><h3>原始空白校名</h3><p>${blankRows.length}列；依要求保留，不納入學校數及縣市辨識。</p></div>
    <div class="quality-item"><h3>非學校型態資料</h3><p>${nonSchoolRows.length}列：${nonSchoolRows.map(r=>esc(r.displayName)).join('、')||'無'}；保留人數，但不視為單一學校或指定縣市。</p></div>`;
}

function activePanelId(){return document.querySelector('.panel.active')?.id||'overview';}

function renderActivePanel(){
  switch(activePanelId()){
    case 'overview': renderYearChart();renderAdvice();break;
    case 'ranking': renderRanking();break;
    case 'trend': renderSchoolOptions();renderSchool();break;
    case 'location': renderLocation();break;
    case 'change': renderChange();break;
    case 'table': renderTable();break;
    case 'quality': renderQuality();break;
  }
}

function renderDashboard({refreshOptions=false,updateKpis=true}={}){
  if(refreshOptions) refreshFilterOptions();
  updateYearSummary();
  if(updateKpis) renderKPIs();
  renderActivePanel();
}

function scheduleRender(options={}){
  if(renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame=requestAnimationFrame(()=>{
    renderFrame=null;
    fastRender=true;
    renderDashboard(options);
    fastRender=false;
  });
}

function downloadCsv(){
  const rows=[...filteredRows()].sort((a,b)=>currentValue(b)-currentValue(a));const showRaw=els.mergeMode.value==='merged';
  const header=['學校／資料名稱','區域','縣市',...YEARS,'總計',...(showRaw?['原始名稱']:[])];
  const values=rows.map(r=>[r.name,r.region,r.city,...YEARS.map(y=>r[y]),r.total,...(showRaw?[r.rawNames.join(' | ')]:[])]);
  const csv=[header,...values].map(cols=>cols.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='生源學校分析_篩選結果.csv';a.click();URL.revokeObjectURL(url);
}
function downloadPng(){
  const canvas=document.querySelector('.panel.active canvas');
  if(!canvas){showToast('目前頁籤沒有可下載的圖表');return;}
  const a=document.createElement('a');a.href=canvas.toDataURL('image/png',1);a.download='生源學校分析圖表.png';a.click();
}

function bindEvents(){
  els.mergeMode.addEventListener('change',()=>{invalidateAggregateCache();scheduleRender({refreshOptions:true,updateKpis:true});});
  els.topN.addEventListener('change',()=>{if(activePanelId()==='ranking') scheduleRender({updateKpis:false});});
  els.searchInput.addEventListener('input',()=>{
    clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{invalidateFilterCache();scheduleRender({updateKpis:true});},120);
  });
  yearOptionNodes().forEach(input=>input.addEventListener('change',()=>handleYearOptionChange(input)));
  els.regionSelect.addEventListener('change',()=>{
    els.citySelect.value='all';
    invalidateFilterCache();
    scheduleRender({refreshOptions:true,updateKpis:true});
  });
  els.citySelect.addEventListener('change',()=>{invalidateFilterCache();scheduleRender({updateKpis:true});});
  els.schoolSelect.addEventListener('change',()=>{fastRender=true;renderSchool();fastRender=false;});
  $('downloadCsv').addEventListener('click',downloadCsv);$('downloadPng').addEventListener('click',downloadPng);
  $('resetBtn').addEventListener('click',()=>{
    els.mergeMode.value='merged';resetYearOptions();els.regionSelect.value='all';els.citySelect.value='all';els.topN.value='20';els.searchInput.value='';
    invalidateAggregateCache();
    scheduleRender({refreshOptions:true,updateKpis:true});
    showToast('篩選條件已重設');
  });
  document.querySelectorAll('.tab').forEach(button=>button.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
    button.classList.add('active');$(button.dataset.tab).classList.add('active');
    requestAnimationFrame(()=>{fastRender=true;renderActivePanel();fastRender=false;});
  }));
  document.addEventListener('click',event=>{if(els.yearPicker?.open&&!els.yearPicker.contains(event.target)) els.yearPicker.open=false;});
}

if(typeof Chart==='undefined'){
  document.body.innerHTML='<main class="container page"><div class="notice"><strong>Chart.js載入失敗。</strong>此網站使用CDN載入圖表套件，請確認網路連線後重新整理。</div></main>';
}else{
  Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif';
  bindEvents();renderDashboard({refreshOptions:true,updateKpis:true});
}
