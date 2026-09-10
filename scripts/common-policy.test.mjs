import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {parseYaml} from './lib/yaml-lite.mjs';
import {assertAdapterContractShape,assertAdapterPolicyContract} from './lib/adapter-contract.mjs';
import {contactWindowStatus,deploymentApprovalRequirement} from './lib/common-policy.mjs';

const contact={timezone:'Asia/Seoul',days:['mon','tue','wed','thu','fri'],start_hour:10,end_hour:18};
const decision=(extra={})=>deploymentApprovalRequirement({policy:'high_risk_only',systemRisk:'low',trafficRisk:'low',humanOnlyDecision:false,reviewPrepared:true,...extra});

test('contact uses the configured timezone with an exclusive closing hour',()=>{
  for(const [date,allowed] of [['2026-09-10T00:59:59Z',false],['2026-09-10T01:00:00Z',true],['2026-09-10T08:59:59Z',true],['2026-09-10T09:00:00Z',false],['2026-09-12T03:00:00Z',false]]){
    assert.equal(contactWindowStatus(contact,Date.parse(date)).allowed,allowed,date);
  }
});
test('24 hour work schedule is independent of the human contact schedule',()=>{
  const now=Date.parse('2026-09-10T18:00:00Z');
  assert.equal(contactWindowStatus(contact,now).allowed,false);
  assert.equal(contactWindowStatus({...contact,days:[1,2,3,4,5,6,7],start_hour:0,end_hour:24},now).allowed,true);
  assert.equal(decision().action,'continue_host_gates');
});
test('invalid contact schedule or clock is rejected without a guessed default',()=>{
  for(const schedule of [{...contact,timezone:'bad'},{...contact,days:[]},{...contact,end_hour:10}])assert.throws(()=>contactWindowStatus(schedule,0));
  for(const now of [NaN,Infinity,'2026-09-10',null])assert.throws(()=>contactWindowStatus(contact,now));
});
test('all system and traffic risk combinations retain human gates when needed',()=>{
  for(const systemRisk of ['low','medium','high'])for(const trafficRisk of ['low','medium','high'])for(const humanOnlyDecision of [true,false]){
    const expected=systemRisk==='high'||trafficRisk==='high'||humanOnlyDecision?'approval_required':'continue_host_gates';
    assert.equal(decision({systemRisk,trafficRisk,humanOnlyDecision}).action,expected);
    assert.equal(decision({policy:'required',systemRisk,trafficRisk,humanOnlyDecision}).action,'approval_required');
  }
});
test('missing review or unknown risk is agent preparation rather than a new approval',()=>{
  for(const extra of [{reviewPrepared:false},{reviewPrepared:undefined},{systemRisk:'unknown'},{trafficRisk:null},{humanOnlyDecision:'false'},{policy:'never'}]){
    assert.equal(decision(extra).action,'agent_preparation');
  }
});
test('policy-only validation cannot stand in for a complete deployment adapter',()=>{
  const source=parseYaml(fs.readFileSync(new URL('../projects/example/project.yaml',import.meta.url),'utf8'));
  const policy=structuredClone(source);delete policy.execution;delete policy.tiers;delete policy.guards;delete policy.commands.deploy_dev;delete policy.commands.deploy_production;
  assert.doesNotThrow(()=>assertAdapterPolicyContract(policy));
  assert.throws(()=>assertAdapterContractShape(policy),/required field/);
  delete policy.team_policy.authorization.issue_required;
  assert.throws(()=>assertAdapterPolicyContract(policy),/issue_required/);
});
test('policy-only validation retains recipient, role and high-risk invariants',()=>{
  const source=parseYaml(fs.readFileSync(new URL('../projects/example/project.yaml',import.meta.url),'utf8'));
  for(const mutate of [p=>p.team_policy.authorization.chat_grants_authority=true,p=>p.team_policy.approval.high_system_risk='without_approval',p=>p.team_policy.assignment.unanswered_thread_recipient='owner']){
    const p=structuredClone(source);mutate(p);assert.throws(()=>assertAdapterPolicyContract(p));
  }
});
