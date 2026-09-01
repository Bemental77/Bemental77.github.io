#!/usr/bin/env bash
# Apply (idempotently) the flycast-bridge patches to dreamcast/flycast-src/.
#
# Convention: dreamcast/flycast-src/ is treated as upstream — never edited
# in place. All modifications live as numbered .patch files in this
# directory and are applied here before each emcmake configure.
#
# Per patch, we first try `git apply --check` (would-it-apply?). If it would
# apply we apply it. If `--check` fails because the patch is already applied
# (reverse check passes), we skip. Otherwise we surface the error.

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
FLYCAST_SRC="$( cd "${SCRIPT_DIR}/../flycast-src" 2>/dev/null && pwd )" || {
	echo "error: flycast-src not found at ${SCRIPT_DIR}/../flycast-src" >&2
	exit 2
}
PATCHES_DIR="${SCRIPT_DIR}/patches"

if [ ! -d "${FLYCAST_SRC}" ] || [ ! -d "${FLYCAST_SRC}/.git" ]; then
	echo "error: ${FLYCAST_SRC} is not a git repo" >&2
	exit 2
fi

# Files this patchset touches. Refuse to run if any of them carry edits we
# don't recognise as one of our patches (i.e., user made manual changes).
TOUCHED=(
	"core/build.h"
	"shell/cmake/DetectArchitecture.cmake"
	"CMakeLists.txt"
)

cd "${FLYCAST_SRC}"

for f in "${TOUCHED[@]}"; do
	if ! git diff --quiet -- "${f}"; then
		# Determine whether the existing diff is exactly one of our patches
		# already being applied. If `git apply --reverse --check` succeeds
		# for any of our patches against this file, the diff is ours — fine.
		recognised=0
		for p in "${PATCHES_DIR}"/*.patch; do
			[ -e "${p}" ] || continue
			if git apply --reverse --check "${p}" >/dev/null 2>&1; then
				recognised=1
				break
			fi
		done
		if [ "${recognised}" -eq 0 ]; then
			echo "error: ${f} has uncommitted unrelated edits in flycast-src" >&2
			echo "       resolve manually before re-running apply_patches.sh" >&2
			exit 3
		fi
	fi
done

shopt -s nullglob
patches=( "${PATCHES_DIR}"/*.patch )
shopt -u nullglob

if [ "${#patches[@]}" -eq 0 ]; then
	echo "no patches found in ${PATCHES_DIR}"
	exit 0
fi

failed=0
for p in "${patches[@]}"; do
	name="$( basename "${p}" )"
	if git apply --reverse --check "${p}" >/dev/null 2>&1; then
		printf '%-60s skipped (already applied)\n' "${name}"
		continue
	fi
	if git apply --check "${p}" >/dev/null 2>&1; then
		if git apply "${p}" >/dev/null 2>&1; then
			printf '%-60s applied\n' "${name}"
		else
			printf '%-60s failed (apply)\n' "${name}"
			failed=1
		fi
	else
		printf '%-60s failed (--check)\n' "${name}"
		git apply --check "${p}" 2>&1 | sed 's/^/    /' >&2
		failed=1
	fi
done

exit "${failed}"
