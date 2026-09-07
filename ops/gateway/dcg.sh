#!/usr/bin/env bash
# 프로젝트 게이트웨이 CLI와 naia-adk manage-discord-sessions 사이의 운영 진입점.
# 토큰·호스트·채널 ID는 여기에 없다. 환경 변수와 추적하지 않는 런타임만 본다.
set -euo pipefail
set +x

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
adk_root="$(cd "$here/../.." && pwd)"
policy_guard="$adk_root/scripts/policy-guard.mjs"
native_contract="$adk_root/ops/gateway/native-command-contract.json"
native_contract_validator="$adk_root/scripts/native-command-validator.mjs"
project_ctl="${PROJECT_GATEWAY_CTL:-}"
naia_adk_root="${NAIA_ADK_ROOT:-}"
adk_script=""
if [[ -n "$naia_adk_root" ]]; then
  adk_script="$naia_adk_root/.agents/skills/manage-discord-sessions/scripts/manage-discord-sessions.sh"
fi
backend="${NAIA_DCG_BACKEND:-auto}"
unit="${PROJECT_GATEWAY_UNIT:-}"

# Project backend paths are resolved while the caller's working directory is
# still in effect. Mutating project commands later run from the approved
# workspace, so a relative controller must not be reinterpreted there.
if [[ -n "$project_ctl" && "$project_ctl" != /* ]]; then
  project_ctl_dir="$(dirname -- "$project_ctl")"
  project_ctl_name="$(basename -- "$project_ctl")"
  if [[ -d "$project_ctl_dir" ]]; then
    project_ctl="$(cd -- "$project_ctl_dir" && pwd -P)/$project_ctl_name"
  fi
fi

fail() {
  printf 'dcg: %s\n' "$1" >&2
  exit 1
}

args=("$@")
command_offset=0
if (( ${#args[@]} > 0 )) && [[ "${args[0]}" == "--instance" ]]; then
  if (( ${#args[@]} < 2 )) || [[ -z "${args[1]:-}" || "${args[1]}" == --* ]]; then
    fail '--instance requires a value before the command.'
  fi
  command_offset=2
fi

if (( command_offset < ${#args[@]} )); then
  cmd="${args[command_offset]}"
else
  cmd=status
fi
[[ "$cmd" != --* ]] || fail 'the command must be a positional command name.'
policy_subcommand=""
if (( command_offset + 1 < ${#args[@]} )); then
  policy_subcommand="${args[command_offset + 1]}"
fi

# Native helper options use separate tokens. Reject the forms that would make
# the revision/output binding ambiguous, and reject a terminator because this
# wrapper has no unparsed pass-through tail.
for token in "${args[@]}"; do
  case "$token" in
    --) fail 'the -- option terminator is not supported by the gateway wrapper.' ;;
    --revision=*) fail 'use a separate --revision <full-sha> pair.' ;;
    --output=*) fail 'use a separate --output <path> pair.' ;;
    --instance=*) fail 'use --instance <name> before the command.' ;;
  esac
done

# The checked-in native surface is consumed at the wrapper boundary before
# policy evaluation or backend dispatch. The invocation check is kept after
# the wrapper's operation-specific syntax checks below so callers receive the
# bounded policy diagnostic for rejected mutations such as retry or artifacts
# prune; neither path can reach a backend.
if ! command -v node >/dev/null 2>&1 || [[ ! -r "$native_contract" || ! -r "$native_contract_validator" ]]; then
  fail 'the native command contract validator is unavailable.'
fi

case "$backend" in
  auto|project|adk) ;;
  *) fail 'NAIA_DCG_BACKEND must be auto, project, or adk.' ;;
esac

# The local registry and issue projection are owner-managed inputs. This guard
# validates their shape and policy relationship before either the project CLI
# or the optional naia-adk runtime receives a command. It is a trusted-host
# boundary: host authentication, file permissions, and Discord/GitHub client
# credentials are outside this repository and are not replaced by this check.
project_yaml="${GATEWAY_PROJECT_YAML:-}"
if [[ -z "$project_yaml" || ! -r "$project_yaml" ]]; then
  fail 'GATEWAY_PROJECT_YAML must name a readable project adapter.'
fi
if [[ "$project_yaml" != /* ]]; then
  project_yaml_dir="$(dirname -- "$project_yaml")"
  project_yaml_name="$(basename -- "$project_yaml")"
  [[ -d "$project_yaml_dir" ]] || fail 'GATEWAY_PROJECT_YAML parent directory is not accessible.'
  project_yaml="$(cd -- "$project_yaml_dir" && pwd -P)/$project_yaml_name" \
    || fail 'GATEWAY_PROJECT_YAML could not be resolved.'
fi
[[ -r "$project_yaml" ]] || fail 'GATEWAY_PROJECT_YAML must name a readable project adapter.'
if ! command -v node >/dev/null 2>&1 || [[ ! -r "$policy_guard" ]]; then
  printf 'dcg: the policy guard runtime is unavailable.\n' >&2
  exit 2
fi

native_readonly=0
case "$cmd" in
  status|health-check|jobs|job|watch|logs|monitor|history|latest) native_readonly=1 ;;
esac
policy_operation="${PROJECT_POLICY_OPERATION:-}"
if [[ "$cmd" == artifacts ]]; then
  [[ "$policy_subcommand" == list ]] || fail 'artifacts prune is a mutating native operation and is not exposed by dcg.'
  native_readonly=1
fi
if [[ "$cmd" == attachment && -z "$policy_operation" ]]; then
  fail 'attachment writes --output; set PROJECT_POLICY_OPERATION=attachment-download for an explicit bounded download.'
fi
if [[ -z "$policy_operation" ]]; then
  if (( native_readonly == 1 )); then
    policy_operation=read-only
  elif [[ "$cmd" == service || "$cmd" == cutover || "$cmd" == cancel ]]; then
    policy_operation=runtime-management
  else
    fail 'set PROJECT_POLICY_OPERATION for a non-read-only command.'
  fi
fi

if [[ "$policy_operation" == read-only ]]; then
  if (( native_readonly != 1 )); then
    fail 'read-only policy is only valid for a native read-only command or artifacts list.'
  fi
fi

# Bind the declared policy operation to the command that will be delegated.
# The native cutover is a managed runtime operation. Production, database, and
# rollback commands must use an explicitly declared project backend instead.
case "$policy_operation" in
  read-only)
    ;;
  launch)
    case "$cmd:$policy_subcommand" in
      service:start|service:stop|service:restart) ;;
      *) fail 'launch policy is only valid for service start, stop, or restart.' ;;
    esac
    ;;
  runtime-management)
    case "$cmd:$policy_subcommand" in
      service:status|service:start|service:stop|service:restart|service:unit|cutover:prepare|cutover:verify|cutover:canary|cutover:rollback) ;;
      cancel:*)
        cancel_job_count=0
        cancel_extra_count=0
        for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
          if [[ "${args[arg_index]}" != --job ]]; then
            ((cancel_extra_count += 1))
            continue
          fi
          ((cancel_job_count += 1))
          if (( arg_index + 1 >= ${#args[@]} )) || [[ -z "${args[arg_index + 1]}" || "${args[arg_index + 1]}" == --* ]]; then
            fail 'cancel requires --job <id>.'
          fi
          ((arg_index += 1))
        done
        (( cancel_job_count == 1 )) || fail 'cancel requires exactly one --job <id>.'
        (( cancel_extra_count == 0 )) || fail 'cancel accepts only --job <id>.'
        ;;
      *) fail 'runtime-management is only valid for native service or cutover management.' ;;
    esac
    ;;
  contact-window)
    if [[ "$cmd" != contact-window || -n "$policy_subcommand" ]]; then
      fail 'contact-window policy is a standalone validation command.'
    fi
    ;;
  issue-work)
    case "$cmd" in
      submit|restart|amend) ;;
      retry) fail 'native runtime has no retry command; use restart --job <id>.' ;;
      *) fail 'issue-work policy is only valid for submit, restart, or amend.' ;;
    esac
    if [[ "$cmd" == restart ]]; then
      restart_job_count=0
      for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
        if [[ "${args[arg_index]}" == --job ]]; then
          ((restart_job_count += 1))
          if (( arg_index + 1 >= ${#args[@]} )) || [[ -z "${args[arg_index + 1]}" || "${args[arg_index + 1]}" == --* ]]; then
            fail 'restart requires --job <id>.'
          fi
          ((arg_index += 1))
        fi
      done
      (( restart_job_count == 1 )) || fail 'restart requires exactly one --job <id>.'
    fi
    ;;
  attachment-download)
    [[ "$cmd" == attachment ]] || fail 'attachment-download policy is only valid for attachment.'
    output_count=0
    for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
      if [[ "${args[arg_index]}" == --output ]]; then
        ((output_count += 1))
        if (( arg_index + 1 >= ${#args[@]} )) || [[ -z "${args[arg_index + 1]}" || "${args[arg_index + 1]}" == --* ]]; then
          fail 'attachment download requires --output <path>.'
        fi
        ((arg_index += 1))
      fi
    done
    (( output_count == 1 )) || fail 'attachment download requires exactly one --output <path>.'
    ;;
  production-deploy|database-write|rollback)
    case "$cmd" in
      status|health-check|jobs|job|watch|logs|monitor|cancel|restart|amend|submit|history|latest|attachment|reply|service|cutover|artifacts)
        fail 'high-impact operations require an explicit project backend command; native runtime commands are not production backends.'
        ;;
    esac
    ;;
  *)
    fail 'unsupported policy operation.'
    ;;
esac

if ! node "$native_contract_validator" --contract "$native_contract" -- "${args[@]}" >/dev/null 2>&1; then
  fail 'the native command contract rejected this command.'
fi

validate_native_dependency() {
  [[ -n "$naia_adk_root" && "$naia_adk_root" = /* && -d "$naia_adk_root" ]] \
    || fail 'native dispatch requires an explicit absolute NAIA_ADK_ROOT.'
  if ! node "$native_contract_validator" \
      --contract "$native_contract" \
      --native-root "$naia_adk_root" \
      -- "${args[@]}" >/dev/null 2>&1; then
    fail 'the supplied naia-adk native command contract is incompatible.'
  fi
}

high_impact=0
case "$policy_operation" in
  production-deploy|database-write|rollback) high_impact=1 ;;
esac

if (( command_offset > 0 )) && {
  [[ "$policy_operation" == issue-work ]] || (( high_impact == 1 ));
}; then
  fail '--instance is reserved for native runtime commands and cannot reach a project backend.'
fi

# A high-impact approval is for one exact revision. Read it from the command
# that will be delegated so the guard and the project backend receive the same
# value. POLICY_REVISION is only a compatibility assertion for existing hosts.
policy_revision="${POLICY_REVISION:-}"
revision_count=0
revision_value=""
for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
  if [[ "${args[arg_index]}" != --revision ]]; then
    continue
  fi
  ((revision_count += 1))
  if (( arg_index + 1 >= ${#args[@]} )) || [[ -z "${args[arg_index + 1]}" || "${args[arg_index + 1]}" == --* ]]; then
    fail 'high-impact operation requires --revision <full-sha>.'
  fi
  revision_value="${args[arg_index + 1]}"
  ((arg_index += 1))
done
if (( high_impact == 1 )); then
  if (( revision_count != 1 )) || [[ ! "$revision_value" =~ ^[0-9a-fA-F]{40}$ ]]; then
    fail 'high-impact operation requires exactly one full --revision SHA.'
  fi
  if [[ -n "$policy_revision" && "$policy_revision" != "$revision_value" ]]; then
    fail 'POLICY_REVISION does not match the delegated --revision.'
  fi
  policy_revision="$revision_value"
elif (( revision_count > 0 )); then
  fail '--revision is reserved for high-impact project backend operations.'
fi

if (( high_impact == 1 )); then
  if [[ "$backend" != project ]]; then
    fail 'high-impact operations require NAIA_DCG_BACKEND=project and a declared project backend.'
  fi
  if [[ -z "$project_ctl" || ! -x "$project_ctl" ]]; then
    fail 'high-impact operations require an executable PROJECT_GATEWAY_CTL project backend.'
  fi
fi

guard_args=(
  --operation "$policy_operation"
  --adapter "$project_yaml"
  --command "$cmd"
)
[[ -n "${GATEWAY_PARTICIPANT_REGISTRY:-}" ]] \
  && guard_args+=(--registry "$GATEWAY_PARTICIPANT_REGISTRY")
[[ -n "${POLICY_SENDER_ID:-}" ]] \
  && guard_args+=(--sender-id "$POLICY_SENDER_ID")
[[ -n "${POLICY_ACTOR_ALIAS:-}" ]] \
  && guard_args+=(--actor-alias "$POLICY_ACTOR_ALIAS")
[[ -n "${POLICY_ISSUE_EVIDENCE:-}" ]] \
  && guard_args+=(--issue-evidence "$POLICY_ISSUE_EVIDENCE")
[[ -n "$policy_revision" ]] \
  && guard_args+=(--revision "$policy_revision")

case "$policy_operation" in
  issue-work|production-deploy|database-write|rollback|attachment-download)
    target_workspace="${PROJECT_GATEWAY_WORKSPACE:-}"
    [[ -n "$target_workspace" ]] || fail 'mutating project work requires PROJECT_GATEWAY_WORKSPACE.'
    [[ "$target_workspace" = /* ]] || fail 'PROJECT_GATEWAY_WORKSPACE must be an absolute existing directory.'
    [[ -d "$target_workspace" ]] || fail 'PROJECT_GATEWAY_WORKSPACE must be an absolute existing directory.'
    canonical_workspace="$(cd -- "$target_workspace" && pwd -P)" \
      || fail 'PROJECT_GATEWAY_WORKSPACE could not be resolved.'
    export PROJECT_GATEWAY_WORKSPACE="$canonical_workspace"
    guard_args+=(--target-workspace "$canonical_workspace")
    ;;
esac

if [[ "$policy_operation" == attachment-download ]]; then
  attachment_output=""
  output_count=0
  for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
    if [[ "${args[arg_index]}" != --output ]]; then
      continue
    fi
    ((output_count += 1))
    attachment_output="${args[arg_index + 1]:-}"
    ((arg_index += 1))
  done
  (( output_count == 1 )) || fail 'attachment download requires exactly one --output <path>.'
  guard_args+=(--output "$attachment_output")
fi

if [[ "${POLICY_GUARD_TEST_CLOCK:-0}" == 1 ]]; then
  [[ -n "${POLICY_DAY:-}" && -n "${POLICY_HOUR:-}" ]] \
    || fail 'test clock requires POLICY_DAY and POLICY_HOUR.'
  guard_args+=(--day "$POLICY_DAY" --hour "$POLICY_HOUR")
fi

for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
  guard_args+=(--arg "${args[arg_index]}")
done

policy_error_file="$(mktemp "${TMPDIR:-/tmp}/naia-dcg-policy.XXXXXX")"
policy_status=0
node "$policy_guard" "${guard_args[@]}" > /dev/null 2>"$policy_error_file" || policy_status=$?
if (( policy_status != 0 )); then
  policy_reason="$(sed -n 's/^policy guard rejected: //p' "$policy_error_file" | head -n 1)"
  rm -f "$policy_error_file"
  if [[ -n "$policy_reason" ]]; then
    printf 'dcg: %s\n' "$policy_reason" >&2
  else
    printf 'dcg: policy guard rejected the requested operation.\n' >&2
  fi
  exit 1
fi
rm -f "$policy_error_file"

# This command is intentionally a local policy check and has no backend
# equivalent. Keep it from being mistaken for a live Discord activation.
if [[ "$policy_operation" == contact-window ]]; then
  exit 0
fi

project_alive() {
  [[ -n "$unit" ]] && systemctl --user is-active --quiet "$unit"
}

delegate_project_backend() {
  [[ -n "${canonical_workspace:-}" ]] || fail 'mutating project work has no canonical workspace.'
  cd -- "$canonical_workspace" || fail 'approved project workspace is not accessible.'
  if (( ${#delegated_args[@]} > 0 )); then
    exec "$project_ctl" "${delegated_args[@]}"
  fi
  exec "$project_ctl" "${args[@]}"
}

delegated_args=()

# The native naia-adk helper has no authenticated project issue adapter. An
# issue mutation therefore needs an explicitly selected project backend with
# the workspace projection already checked above; it must never fall through
# to the personal runtime.
if [[ "$policy_operation" == issue-work ]]; then
  [[ "$backend" == project ]] || fail 'issue-work requires an explicit project backend; native naia-adk issue dispatch is unsupported.'
  [[ -n "$project_ctl" && -x "$project_ctl" ]] || fail 'issue-work requires an executable PROJECT_GATEWAY_CTL project backend.'
  issue_argv_file="$(mktemp "${TMPDIR:-/tmp}/naia-dcg-issue-argv.XXXXXX")"
  issue_error_file="$(mktemp "${TMPDIR:-/tmp}/naia-dcg-issue-error.XXXXXX")"
  issue_helper_args=(
    --adapter "$project_yaml"
    --operation issue-work
    --command "$cmd"
  )
  [[ -n "${POLICY_ISSUE_EVIDENCE:-}" ]] \
    && issue_helper_args+=(--issue-evidence "$POLICY_ISSUE_EVIDENCE")
  for ((arg_index = command_offset + 1; arg_index < ${#args[@]}; arg_index += 1)); do
    issue_helper_args+=(--arg "${args[arg_index]}")
  done
  issue_helper_status=0
  node "$adk_root/scripts/project-backend-argv.mjs" "${issue_helper_args[@]}" >"$issue_argv_file" 2>"$issue_error_file" || issue_helper_status=$?
  if (( issue_helper_status != 0 )); then
    issue_reason="$(sed -n 's/^project backend argv rejected: //p' "$issue_error_file" | head -n 1)"
    rm -f "$issue_argv_file" "$issue_error_file"
    [[ -n "$issue_reason" ]] || issue_reason='project backend capability rejected the issue command'
    fail "$issue_reason"
  fi
  while IFS= read -r -d '' delegated_token; do
    delegated_args+=("$delegated_token")
  done <"$issue_argv_file"
  rm -f "$issue_argv_file" "$issue_error_file"
  delegate_project_backend
fi

# Native managed runtime operations are owner-local recovery operations. The
# host that owns the runtime performs service, cutover, and cancel; they are
# never forwarded to a project backend. A remote router needs its own
# authenticated owner permission before it may request that local operation.
# Bounded attachment downloads remain native helper operations as well.
if [[ "$policy_operation" == runtime-management || "$policy_operation" == attachment-download ]]; then
  [[ "$backend" != project ]] || fail 'service, cutover, and cancel are owner-local recovery and cannot be forwarded to a project backend.'
  [[ -x "$adk_script" ]] || {
    printf 'dcg: NAIA_ADK_ROOT must point to an executable naia-adk runtime script.\n' >&2
    exit 127
  }
  validate_native_dependency
  exec "$adk_script" "${args[@]}"
fi

if (( high_impact == 1 )); then
  delegate_project_backend
fi

if [[ -n "$project_ctl" && -x "$project_ctl" ]]; then
  if [[ "$backend" == project ]] || { [[ "$backend" == auto ]] && project_alive; }; then
    exec "$project_ctl" "${args[@]}"
  fi
fi

if [[ "$backend" != project && -x "$adk_script" ]]; then
  validate_native_dependency
  exec "$adk_script" "${args[@]}"
fi

if [[ "$backend" == project ]]; then
  [[ -n "$project_ctl" && -x "$project_ctl" ]] || fail 'NAIA_DCG_BACKEND=project requires an executable PROJECT_GATEWAY_CTL.'
  exec "$project_ctl" "${args[@]}"
fi

if [[ "$backend" == adk ]]; then
  [[ -x "$adk_script" ]] || fail 'NAIA_DCG_BACKEND=adk requires an executable NAIA_ADK_ROOT runtime script.'
  validate_native_dependency
  exec "$adk_script" "${args[@]}"
fi

printf 'dcg: 프로젝트 CLI(PROJECT_GATEWAY_CTL)도 naia-adk 스크립트도 없습니다.\n' >&2
printf '명령: %s\n' "$cmd" >&2
exit 127
