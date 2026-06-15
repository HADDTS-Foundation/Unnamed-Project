#!/usr/bin/env python3
"""One-command driver to (re)build app-data.js for the configured neighborhood size.

Runs the pipeline steps in order (BUILD-PROMPT §5). With the neighborhood now set
to 250 (enrich/topup/netfetch slices + build_data.TOPN), this regenerates the
snapshot for the top-250 STRING interactors of CTBP1.

  cd into the project root, then:   python3 data/run_all.py

Notes
  * Needs network — it makes a few thousand live API calls (STRING, Open Targets,
    Europe PMC, IntAct, NCBI ClinVar, HPO, Reactome, GenAge). Budget ~20-40 min;
    NCBI ClinVar is rate-limited (3 req/s) so `annotate` is the slow one.
  * `build_data` REBUILDS app-data.js from scratch, so a partial run leaves it
    incomplete. This script first backs up the current file to app-data.bak.js.
  * Resumable: if a step fails, fix the cause and re-run from it, e.g.
        python3 data/run_all.py --from evidence
    (steps overwrite their own fields for every node, so re-running is safe.)
  * Stdlib only, to match the rest of data/.
"""
import os, sys, subprocess, time, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # project root (parent of data/)
APP = os.path.join(ROOT, 'app-data.js')

# (step script, one-line description, rough scale)
STEPS = [
    ('enrich',     'Open Targets areas/diseases/function/tractability + CTBP1 co-mention', '~2 calls/gene'),
    ('topup',      'fill any Open Targets gaps from enrich',                                'gaps only'),
    ('netfetch',   'partner-partner STRING network (>=0.4) for the neighborhood',           '1 call'),
    ('build_data', 'assemble app-data.js (LOCAL; rebuilds the file from caches)',           'local'),
    ('refs',       'Europe PMC references + UniProt function-evidence PMIDs per gene',       '~1 call/gene'),
    ('diseases',   'widen Open Targets disease list to top-20 per gene',                     '~1 call/gene'),
    ('evidence',   'tiered synonym-aware co-mention + IntAct + pair-focused refs + agingRefs', '~4 calls/gene'),
    ('annotate',   'ClinVar P/LP·VUS·total + HPO + Reactome + IDs per gene (SLOW: NCBI 3/s)', '~5 calls/gene'),
    ('genage',     'GenAge u LongevityMap aging/longevity membership',                       '2 downloads'),
]
NAMES = [s[0] for s in STEPS]


def main():
    start_at = 0
    if '--from' in sys.argv:
        try:
            want = sys.argv[sys.argv.index('--from') + 1]
            start_at = NAMES.index(want)
        except (ValueError, IndexError):
            print('--from must be one of:', ', '.join(NAMES)); sys.exit(2)

    os.chdir(ROOT)   # the data/*.py scripts use both 'data/...' and __file__-relative paths; root satisfies both

    if start_at == 0 and os.path.exists(APP):
        shutil.copy2(APP, os.path.join(ROOT, 'app-data.bak.js'))
        print('backed up current app-data.js -> app-data.bak.js')

    print('\nNeighborhood rebuild — running %d step(s) from "%s"\n' % (len(STEPS) - start_at, NAMES[start_at]))
    t0 = time.time()
    for i in range(start_at, len(STEPS)):
        name, desc, scale = STEPS[i]
        print('=' * 78)
        print('[%d/%d] %-10s  %s  (%s)' % (i + 1, len(STEPS), name, desc, scale))
        print('=' * 78)
        st = time.time()
        rc = subprocess.call([sys.executable, os.path.join('data', name + '.py')])
        dt = time.time() - st
        if rc != 0:
            print('\n*** STEP "%s" FAILED (exit %d) after %.0fs.' % (name, rc, dt))
            print('    Fix the cause (often a transient network error) and resume with:')
            print('        python3 data/run_all.py --from %s' % name)
            print('    Your previous snapshot is preserved at app-data.bak.js')
            sys.exit(1)
        print('--- %s ok (%.0fs) ---\n' % (name, dt))

    print('=' * 78)
    print('DONE in %.1f min. app-data.js rebuilt.' % ((time.time() - t0) / 60))
    print('Next: run `node data/verify.js` and the headless boot, then it is ready to commit.')
    print('(app-data.bak.js holds the prior snapshot if you need to roll back.)')


if __name__ == '__main__':
    main()
