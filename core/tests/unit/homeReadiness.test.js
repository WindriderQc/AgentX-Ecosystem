const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/home.js'), 'utf8');
async function renderStatus(health, routing, offline = false) {
 const nodes = {};
 function element() { return {dataset:{},textContent:'',children:[],className:'',addEventListener(){},querySelector(){return element()},replaceChildren(){this.children=[]},appendChild(n){this.children.push(n)},get childElementCount(){return this.children.length}}; }
 const context = {document:{getElementById(id){return nodes[id] ||= element()},querySelectorAll(){return []},createElement:element},AbortController,Date,setTimeout,clearTimeout,setInterval(){},fetch:async url=>{if(offline)throw Error('offline');return {ok:true,json:async()=>url.includes('routing')?routing:health}}};
 vm.runInNewContext(source,context);
 for(let i=0;i<12;i++)await Promise.resolve();
 return nodes;
}
const routing={taskModels:{general_chat:{host:'local',model:'sample'}},hosts:{local:{models:['sample']}}};
const healthy={services:[{id:'core',status:'ok',detail:{ollama:'connected'}}],consistency:{status:'ok'},summary:{status:'ok'}};
test('home reports readiness only with observed routing and matching identity',async()=>{
 expect((await renderStatus(healthy,routing)).homeReadinessLabel.textContent).toBe('Ready to chat');
 expect((await renderStatus({...healthy,consistency:{}},routing)).homeReadinessLabel.textContent).toBe('Deployment needs attention');
 expect((await renderStatus(healthy,null)).homeReadinessLabel.textContent).toBe('Chat route not observed');
});
test('home exposes mismatch and connection failures without disabling navigation',async()=>{
 const mismatch=await renderStatus({...healthy,consistency:{status:'degraded',issues:['Versions differ']}},routing);
 expect(mismatch.homeConsistency.textContent).toContain('Versions differ');
 const offline=await renderStatus(healthy,routing,true);
 expect(offline.homeReadinessLabel.textContent).toBe('Status not observed');
 expect(offline.homeStatusRefresh.disabled).toBe(false);
});
