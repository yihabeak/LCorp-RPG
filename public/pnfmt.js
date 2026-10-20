/* 패치노트 서식 — 작성 도구와 게임이 같은 규칙으로 그린다. 모든 글자는 먼저 이스케이프한 뒤 정해진 표시만 태그로 바꾼다. */
var PNF=(function(){
var COL={빨강:'#ff6b5e',주황:'#ffa94d',노랑:'#ffe066',초록:'#69db7c',청록:'#3bc9db',파랑:'#74c0fc',보라:'#c39bff',분홍:'#f783ac',회색:'#9aa5a1',
 red:'#ff6b5e',orange:'#ffa94d',yellow:'#ffe066',green:'#69db7c',cyan:'#3bc9db',blue:'#74c0fc',purple:'#c39bff',pink:'#f783ac',gray:'#9aa5a1',
 RED:'#e0453a',WHITE:'#f1efe6',BLACK:'#a77bd6',PALE:'#4fd1c5'};
var SZ={큰:'1.25em',아주큰:'1.6em',작은:'.85em',big:'1.25em',huge:'1.6em',small:'.85em'};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function badge(t){var k=/신규|추가|new|add|新/i.test(t)?'n':/수정|고침|fix|변경|change|修正|変更/i.test(t)?'f':/삭제|제거|remove|削除/i.test(t)?'d':/밸런스|balance|調整/i.test(t)?'b':/버그|bug/i.test(t)?'g':'e';return '<span class="pnf-bd pnf-bd-'+k+'">'+t+'</span>'}
function inl(s){var keep=[];s=esc(s).replace(/`([^`]+)`/g,function(m,a){keep.push('<code>'+a+'</code>');return '\u0000'+(keep.length-1)+'\u0000'});
 s=s.replace(/\[\[([^\]]{1,24})\]\]/g,function(m,a){return badge(a)})
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
  .replace(/__(.+?)__/g,'<u>$1</u>')
  .replace(/~~(.+?)~~/g,'<s>$1</s>')
  .replace(/==(.+?)==/g,'<mark>$1</mark>')
  .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g,'$1<i>$2</i>');
 for(var i=0;i<4;i++)s=s.replace(/\{([^{}:|]{1,8})[:|]([^{}]*)\}/g,function(m,k,a){k=k.trim();if(COL[k])return '<span style="color:'+COL[k]+'">'+a+'</span>';if(SZ[k])return '<span style="font-size:'+SZ[k]+'">'+a+'</span>';if(/^#[0-9a-fA-F]{3,6}$/.test(k))return '<span style="color:'+k+'">'+a+'</span>';return m});
 return s.replace(/\u0000(\d+)\u0000/g,function(m,i){return keep[+i]})}
function table(rows){var h=null,b=[];rows.forEach(function(r){var c=r.replace(/^\s*\||\|\s*$/g,'').split('|').map(function(x){return x.trim()});if(c.every(function(x){return /^:?-{2,}:?$/.test(x)})){if(b.length&&!h)h=b.pop();return}b.push(c)});
 return '<div class="pnf-tw"><table class="pnf-t">'+(h?'<thead><tr>'+h.map(function(x){return '<th>'+inl(x)+'</th>'}).join('')+'</tr></thead>':'')+'<tbody>'+b.map(function(r){return '<tr>'+r.map(function(x){return '<td>'+inl(x)+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>'}
function render(src){var L=String(src||'').replace(/\r\n/g,'\n').split('\n'),o=[],i=0,stack=0;
 function list(tag,re){var it=[];while(i<L.length&&re.test(L[i])){var m=re.exec(L[i]);var sub=[];i++;while(i<L.length&&/^ {2,}(?:[-*]|\d+\.) /.test(L[i])){sub.push(L[i].replace(/^ {2,}/,''));i++}
   it.push('<li>'+inl(m[1])+(sub.length?render(sub.join('\n')):'')+'</li>')}o.push('<'+tag+'>'+it.join('')+'</'+tag+'>')}
 while(i<L.length){var l=L[i],m;
  if(/^\s*$/.test(l)){i++;continue}
  if(m=/^:::\s*(.*)$/.exec(l)){if(m[1]){o.push('<details class="pnf-fold"><summary>'+inl(m[1])+'</summary><div>');stack++}else if(stack){o.push('</div></details>');stack--}i++;continue}
  if(m=/^(#{1,3}) (.*)$/.exec(l)){var n=m[1].length;o.push('<div class="pnf-h pnf-h'+n+'">'+inl(m[2])+'</div>');i++;continue}
  if(/^(-{3,}|={3,})\s*$/.test(l)){o.push('<hr class="pnf-hr">');i++;continue}
  if(/^\s*\|/.test(l)){var r=[];while(i<L.length&&/^\s*\|/.test(L[i]))r.push(L[i++]);o.push(table(r));continue}
  if(/^[-*] /.test(l)){list('ul',/^[-*] (.*)$/);continue}
  if(/^\d+\. /.test(l)){list('ol',/^\d+\. (.*)$/);continue}
  if(m=/^(>|!>|\+>|i>) ?(.*)$/.exec(l)){var k=m[1],q=[];while(i<L.length&&(m=/^(>|!>|\+>|i>) ?(.*)$/.exec(L[i]))&&m[1]===k){q.push(m[2]);i++}
   var cls=k==='>'?'pnf-q':k==='!>'?'pnf-c pnf-warn':k==='+>'?'pnf-c pnf-new':'pnf-c pnf-info';o.push('<div class="'+cls+'">'+render(q.join('\n'))+'</div>');continue}
  if(m=/^->\s*(.*?)\s*<-\s*$/.exec(l)){o.push('<p style="text-align:center">'+inl(m[1])+'</p>');i++;continue}
  if(m=/^->\s*(.*)$/.exec(l)){o.push('<p style="text-align:right">'+inl(m[1])+'</p>');i++;continue}
  var p=[];while(i<L.length&&!/^\s*$/.test(L[i])&&!/^(#{1,3} |[-*] |\d+\. |>|!>|\+>|i>|:::|\s*\||-{3,}\s*$|={3,}\s*$|->)/.test(L[i]))p.push(inl(L[i++]));
  if(p.length)o.push('<p>'+p.join('<br>')+'</p>');else{o.push('<p>'+inl(L[i])+'</p>');i++}}
 while(stack--)o.push('</div></details>');return o.join('')}
var CSS='.pnf{line-height:1.7;word-break:keep-all;overflow-wrap:anywhere}.pnf p{margin:.35em 0}.pnf ul,.pnf ol{margin:.3em 0;padding-left:1.4em}.pnf li{margin:.15em 0}'+
'.pnf-h{font-weight:800;margin:.9em 0 .35em;line-height:1.35}.pnf-h1{font-size:1.35em;border-bottom:2px solid currentColor;padding-bottom:.15em}.pnf-h2{font-size:1.15em}.pnf-h3{font-size:1.02em;opacity:.9}'+
'.pnf-hr{border:0;border-top:1px dashed rgba(160,170,165,.55);margin:.9em 0}.pnf mark{background:#ffe066;color:#111;padding:0 .2em;border-radius:3px}.pnf code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;background:rgba(127,127,127,.2);padding:.05em .35em;border-radius:4px}'+
'.pnf a{color:#74c0fc;text-decoration:underline}.pnf-q{border-left:3px solid rgba(160,170,165,.7);padding:.1em .8em;margin:.5em 0;opacity:.9}'+
'.pnf-c{border:1px solid;border-left-width:5px;border-radius:6px;padding:.25em .8em;margin:.55em 0}.pnf-warn{border-color:#ff6b5e;background:rgba(255,107,94,.1)}.pnf-new{border-color:#69db7c;background:rgba(105,219,124,.1)}.pnf-info{border-color:#74c0fc;background:rgba(116,192,252,.1)}'+
'.pnf-bd{display:inline-block;font-size:.78em;font-weight:800;padding:.05em .5em;border-radius:4px;color:#111;vertical-align:.08em;margin-right:.25em}.pnf-bd-n{background:#69db7c}.pnf-bd-f{background:#74c0fc}.pnf-bd-d{background:#ff6b5e}.pnf-bd-b{background:#ffa94d}.pnf-bd-g{background:#f783ac}.pnf-bd-e{background:#c9d1ce}'+
'.pnf-tw{overflow-x:auto;margin:.5em 0}.pnf-t{border-collapse:collapse;min-width:60%}.pnf-t th,.pnf-t td{border:1px solid rgba(160,170,165,.45);padding:.3em .6em;text-align:left;vertical-align:top}.pnf-t th{background:rgba(127,127,127,.18)}'+
'.pnf-fold{border:1px solid rgba(160,170,165,.45);border-radius:6px;margin:.5em 0}.pnf-fold>summary{cursor:pointer;padding:.35em .7em;font-weight:700}.pnf-fold>div{padding:0 .8em .4em}';
return {render:render,css:CSS,colors:COL}})();
