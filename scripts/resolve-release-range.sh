#!/usr/bin/env bash
set -euo pipefail

current_tag=${1:-}
output_file=${2:-}
stable_tag_pattern='^v[0-9]+\.[0-9]+\.[0-9]+$'

if [[ ! $current_tag =~ $stable_tag_pattern ]]; then
  echo "Current release tag must be a stable vMAJOR.MINOR.PATCH tag: $current_tag" >&2
  exit 1
fi
if [[ -z $output_file ]]; then
  echo "An output file is required" >&2
  exit 1
fi

git rev-parse --verify "${current_tag}^{commit}" >/dev/null

previous_tag=$(
  git tag --merged "$current_tag" --list 'v*' \
    | awk '$0 ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/' \
    | awk -v current="$current_tag" '$0 != current' \
    | sort -V -r \
    | head -n 1
)

if [[ -n $previous_tag ]]; then
  from_revision=$previous_tag
else
  from_revision=$(git rev-list --max-parents=0 "$current_tag" | tail -n 1)
fi

if [[ -z $from_revision ]]; then
  echo "Could not resolve a release range start for $current_tag" >&2
  exit 1
fi

git rev-parse --verify "${from_revision}^{commit}" >/dev/null
if [[ $(git rev-parse "${from_revision}^{commit}") == $(git rev-parse "${current_tag}^{commit}") ]]; then
  echo "Release range is empty: $from_revision and $current_tag resolve to the same commit" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$from_revision" "$current_tag"; then
  echo "Release range start $from_revision is not an ancestor of $current_tag" >&2
  exit 1
fi

{
  printf 'from=%s\n' "$from_revision"
  printf 'to=%s\n' "$current_tag"
} >> "$output_file"
