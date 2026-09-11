// Pure host policy. These results grant no execution or transport authority.
import {requireSchedule, normalizeDay} from './adapter-contract.mjs';

export function contactWindowStatus(schedule, now = Date.now()) {
  const checked=requireSchedule(schedule, 'contact window');
  const instant=now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(instant)) throw new Error('invalid contact clock');
  const parts=new Intl.DateTimeFormat('en-US', {
    timeZone:checked.timezone,weekday:'short',hour:'numeric',hourCycle:'h23',
  }).formatToParts(new Date(instant));
  const part=type=>parts.find(item=>item.type===type)?.value;
  const day=normalizeDay(part('weekday'),'contact day'),hour=Number(part('hour'));
  return {allowed:checked.days.includes(day)&&hour>=checked.start_hour&&hour<checked.end_hour,
    timezone:checked.timezone,day,hour};
}

export function deploymentApprovalRequirement({policy,systemRisk,trafficRisk,humanOnlyDecision,reviewPrepared,environment='production',approvalEnvironments=['production','staging','dev','personal']}) {
  if (!['required','high_risk_only'].includes(policy)) return {action:'agent_preparation',reason:'invalid_approval_policy'};
  if (!['production','staging','dev','personal'].includes(environment)) return {action:'agent_preparation',reason:'deployment_environment_required'};
  if (!Array.isArray(approvalEnvironments)||approvalEnvironments.length===0
      ||new Set(approvalEnvironments).size!==approvalEnvironments.length
      ||Array.from(approvalEnvironments).some(value=>!['production','staging','dev','personal'].includes(value))) {
    return {action:'agent_preparation',reason:'approval_environment_scope_required'};
  }
  if (reviewPrepared!==true) return {action:'agent_preparation',reason:'review_preparation_required'};
  if (!['low','medium','high'].includes(systemRisk)||!['low','medium','high'].includes(trafficRisk)
      ||typeof humanOnlyDecision!=='boolean') return {action:'agent_preparation',reason:'risk_assessment_required'};
  // Only a reviewed host policy may narrow this scope. Omitting it preserves
  // the existing all-environment rule. Human-only decisions stay independent.
  const inScope=approvalEnvironments.includes(environment);
  const required=humanOnlyDecision||(inScope&&(policy==='required'||systemRisk==='high'||trafficRisk==='high'));
  return {action:required?'approval_required':'continue_host_gates',reason:required?'policy_requires_authorization':inScope?'nonhigh_risk_reviewed':'environment_outside_approval_scope'};
}

// A technical acceptance contract is not a business/legal commitment. Hosts
// must identify the decision itself, rather than relabeling agent work human-only.
export function humanOnlyDecisionRequirement({kind,purpose}={}) {
  if (['technical_verification','browser_verification','agent_preparation'].includes(purpose)) {
    return {action:'agent_preparation',reason:'agent_executable_work'};
  }
  const purposes={purchase:'spending_commitment',contract:'legal_commitment',
    license:'license_terms',payment_key:'payment_key_issuance'};
  if (!Object.hasOwn(purposes,kind)||purposes[kind]!==purpose) {
    return {action:'agent_preparation',reason:'human_decision_basis_required'};
  }
  return {action:'human_decision',reason:'identified_human_decision'};
}
