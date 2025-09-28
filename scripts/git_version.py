# PlatformIO pre-script to inject version info from Git
import subprocess
import os

Import('env')

def git(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL).decode('utf-8').strip()
    except Exception:
        return ''

# Read git describe or fallback to short hash
version = git('git describe --tags --dirty --always') or git('git rev-parse --short HEAD') or 'dev'
commit = git('git rev-parse --short HEAD') or 'unknown'
branch = git('git rev-parse --abbrev-ref HEAD') or ''

# Optional: strip leading 'v'
if version.startswith('v'):
    version = version[1:]

# Build time
from datetime import datetime
build_time = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')

# Inject as C/C++ macros
cpp_defines = env['CPPDEFINES']
cpp_defines.append(('FW_VERSION', '"%s"' % version))
cpp_defines.append(('GIT_COMMIT', '"%s"' % commit))
cpp_defines.append(('GIT_BRANCH', '"%s"' % branch))
cpp_defines.append(('BUILD_TIME', '"%s"' % build_time))

env.Replace(CPPDEFINES=cpp_defines)
