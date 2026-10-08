#!/usr/bin/env python3
"""Build data/words.js from the Greek KELLY list and English Wiktionary glosses.

Usage:
  python3 -I tools/build-words.py <KELLY_EL.xlsx> <kaikki-Greek.jsonl.gz> [out.js] [--missing]

--missing prints the words still without a gloss (add them to tools/glosses-extra.tsv).

Sources (download them yourself, they are not in the repo):
  - KELLY_EL.xlsx: the Greek KELLY list (ILSP / Athena RC, CC BY-NC 4.0),
    https://inventory.clarin.gr/lcr/741 — mirrored at
    https://github.com/kotoshu/frequency-list-kelly/raw/main/references/KELLY_EL.xlsx
  - kaikki.org-dictionary-Greek.jsonl.gz: English Wiktionary extract (CC BY-SA),
    https://kaikki.org/dictionary/Greek/kaikki.org-dictionary-Greek.jsonl.gz

Also writes forms.json next to it: {folded form: word id} for all lemmas and
their inflected forms (from Wiktionary's tables), used to find words in sentences.

Output: `var WORDS = [...]`, one entry per KELLY row, ordered by CEFR level and
then by corpus frequency rank; ids 1..N follow that order.
Word shape: {id, l: 'A1'..'C2', w: Greek, a: article, r: romanization,
             e: English gloss, p: part of speech, x: phrase (MWE), f: rank}
Empty fields are left out.
"""
import gzip, json, re, sys, unicodedata, zipfile
import xml.etree.ElementTree as ET

LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']

# KELLY part of speech (Greek) -> short code; kaikki pos names that match it
POS_MAP = [
    ('ουσιαστικό', 'n', ['noun', 'name']),
    ('ρήμα', 'v', ['verb']),
    ('μετοχή', 'ptcp', ['verb', 'adj', 'participle']),
    ('επίθετο', 'adj', ['adj']),
    ('επίρρημα', 'adv', ['adv']),
    ('επιρρηματική', 'adv', ['adv', 'phrase']),
    ('σύνδεσμος', 'conj', ['conj']),
    ('πρόθεση', 'prep', ['prep']),
    ('αντωνυμία', 'pron', ['pron', 'det']),
    ('αριθμητικό', 'num', ['num']),
    ('επιφώνημα', 'intj', ['intj']),
    ('μόριο', 'part', ['particle', 'adv']),
    ('άρθρο', 'art', ['article']),
    ('συντομογραφία', 'abbr', ['abbrev', 'noun']),
    ('έκφραση', 'expr', ['phrase', 'adv']),
]
ARTICLE = {'m': 'ο', 'f': 'η', 'n': 'το'}
# obvious errors in the KELLY source: word -> (level, rank)
FIXES = {'αυτονομία': ('C1', 0)}  # listed as rank 11 / A1
SKIP_SENSE_TAGS = {'obsolete', 'archaic', 'dated', 'rare', 'Ancient-Greek'}


def read_xlsx(path):
    ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    z = zipfile.ZipFile(path)
    strings = [''.join(t.text or '' for t in si.iter(ns + 't'))
               for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(ns + 'si')]
    rows = []
    for row in ET.fromstring(z.read('xl/worksheets/sheet1.xml')).iter(ns + 'row'):
        vals = {}
        for c in row.findall(ns + 'c'):
            col = 0
            for ch in re.match(r'[A-Z]+', c.get('r')).group():
                col = col * 26 + ord(ch) - 64
            v = c.find(ns + 'v')
            if v is None:
                continue
            vals[col - 1] = strings[int(v.text)] if c.get('t') == 's' else v.text
        rows.append([(vals.get(i) or '').strip() for i in range(9)])
    return rows[1:]  # drop header


def map_pos(kelly_pos):
    first = kelly_pos.lower().split(',')[0].strip()
    for key, code, kpos in POS_MAP:
        if first.startswith(key):
            return code, kpos
    return '', []


def clean_gloss(g, limit=60):
    g = re.sub(r'\s*\([^()]*\)', '', g)       # drop explanations in parentheses
    g = re.sub(r'\s+', ' ', g).strip(' ;,:')
    if g.endswith(' senses.'):                 # sense group headers, not glosses
        return ''
    if len(g) > limit:
        g = g[:limit].rsplit(' ', 1)[0].rstrip(' ,;') + '…'
    return g


def load_kaikki(path):
    idx = {}
    with gzip.open(path, 'rt', encoding='utf-8') as fh:
        for line in fh:
            d = json.loads(line)
            if d.get('lang_code') != 'el':
                continue
            idx.setdefault(d['word'], []).append(d)
    return idx


def entry_info(d):
    """Glosses, gender, romanization and alt-of targets of one kaikki entry."""
    glosses, alts = [], []
    for s in d.get('senses', []):
        tags = set(s.get('tags') or [])
        if 'form-of' in tags or 'alt-of' in tags:
            for k in ('alt_of', 'form_of'):
                for t in s.get(k) or []:
                    if t.get('word'):
                        alts.append(t['word'])
            continue
        for g in s.get('glosses') or []:
            glosses.append((bool(tags & SKIP_SENSE_TAGS), clean_gloss(g)))
            break
    head = ' '.join(h.get('expansion', '') for h in d.get('head_templates') or [])
    m = re.search(r'\)\s+(m|f|n)(?:\s+or\s+(m|f|n))?\b', head)
    gender = ''
    if m:
        gender = ARTICLE[m.group(1)] + ('/' + ARTICLE[m.group(2)] if m.group(2) else '')
    roman = next((f['form'] for f in d.get('forms') or [] if 'romanization' in (f.get('tags') or [])), '')
    return glosses, gender, roman, alts


GREEK_WORD = re.compile(r'^[\u0370-\u03ff\u1f00-\u1fff]+$')


def inflected_forms(idx, words):
    """All single-word Greek forms (declension/conjugation tables) of the given lemmas."""
    out = set()
    for w in words:
        for d in idx.get(w) or idx.get(w.lower()) or []:
            for f in d.get('forms') or []:
                form = f.get('form', '').strip()
                if GREEK_WORD.match(form):
                    out.add(form)
    return out


def fold(s):
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return s.lower().replace('ς', 'σ')


def lookup(idx, words, kpos, depth=0):
    """Best (glosses, gender, roman) for the first variant that has glosses."""
    for w in words:
        cands = idx.get(w) or idx.get(w.lower()) or []
        cands = sorted(cands, key=lambda d: 0 if d.get('pos') in kpos else 1)
        for d in cands:
            if kpos and d.get('pos') not in kpos and any(c.get('pos') in kpos for c in cands):
                continue
            glosses, gender, roman, alts = entry_info(d)
            if not glosses and alts and depth == 0:
                g2, gen2, rom2 = lookup(idx, alts, kpos, 1)
                if g2:
                    return g2, gender or gen2, roman or rom2
            if glosses:
                return glosses, gender, roman
    return [], '', ''


def format_glosses(glosses, limit=70):
    common = [g for rare, g in glosses if not rare and g] or [g for _, g in glosses if g]
    out = []
    for g in common:
        if g.lower() not in (o.lower() for o in out):
            out.append(g)
        if len(out) == 3:
            break
    text = ''
    for g in out:
        nxt = (text + '; ' + g) if text else g
        if len(nxt) > limit and text:
            break
        text = nxt
    return text


def variants(s):
    # "μεγάλος,-η,-ο" lists endings, "αγαπώ, αγαπάω" lists alternative forms
    return [v.strip() for v in re.split(r'[,/]', s) if v.strip() and not v.strip().startswith('-')]


def tidy(s):
    return re.sub(r'\s*,\s*', ', ', s.strip())


def load_extra(path):
    """Hand-written glosses (word<TAB>gloss) for words Wiktionary lacks or glosses badly."""
    extra = {}
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                if line.strip() and not line.startswith('#'):
                    w, g = line.rstrip('\n').split('\t', 1)
                    extra[w.strip()] = g.strip()
    except FileNotFoundError:
        pass
    return extra


def main():
    xlsx, kaikki = sys.argv[1], sys.argv[2]
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out_path = args[2] if len(args) > 2 else 'data/words.js'
    rows = read_xlsx(xlsx)
    idx = load_kaikki(kaikki)
    extra = load_extra(__file__.rsplit('/', 1)[0] + '/glosses-extra.tsv')

    plain = {r[4] for r in rows if r[4] and not r[5]}
    seen, words = set(), []
    for rid, freq, _, lvl, lemma, mwe, pos, _, _ in rows:
        if not lemma:
            continue
        lvl = lvl if lvl in LEVELS else 'C2'
        key = (lemma, mwe)
        if key in seen:
            continue
        seen.add(key)
        code, kpos = map_pos(pos)
        if mwe and lemma in plain:
            # the plain lemma has its own row, so this row is the phrase itself
            w, x = mwe, ''
            glosses, gender, roman = lookup(idx, variants(mwe), ['phrase', 'adv', 'noun', 'verb'])
            gender = ''
        else:
            w, x = lemma, mwe
            glosses, gender, roman = lookup(idx, variants(lemma), kpos)
        if code != 'n':
            gender = ''
        rank = int(float(rid)) if rid else 0
        if w in FIXES:
            lvl, rank = FIXES[w]
        w, x = tidy(w), tidy(x)
        e = extra.get(w) or format_glosses(glosses)
        words.append({'l': lvl, 'w': w, 'a': gender, 'r': roman, 'e': e,
                      'p': code, 'x': x, 'f': rank, '_freq': float(freq or 0)})

    words.sort(key=lambda d: (LEVELS.index(d['l']), d['f'] or 10**6, -d['_freq'], d['w'].lower()))
    out = []
    for i, d in enumerate(words, 1):
        e = {'id': i}
        for k in ('l', 'w', 'a', 'r', 'e', 'p', 'x', 'f'):
            if d[k]:
                e[k] = d[k]
        out.append(e)

    # forms.json: folded word form -> word id, for finding words in sentences
    # (stories). The lemma itself wins over another word's inflected form;
    # otherwise the lower id (earlier level, more frequent) wins.
    forms = {}
    for e in out:
        if ' ' in e['w']:
            continue
        for v in variants(e['w']):
            forms.setdefault(fold(v), e['id'])
    lemma_keys = set(forms)
    for e in out:
        if ' ' in e['w']:
            continue
        for f in inflected_forms(idx, variants(e['w'])):
            k = fold(f)
            if k not in lemma_keys and (k not in forms or forms[k] > e['id']):
                forms[k] = e['id']
    forms_path = out_path.rsplit('/', 1)[0] + '/forms.json'
    with open(forms_path, 'w', encoding='utf-8') as fh:
        json.dump(forms, fh, ensure_ascii=False, separators=(',', ':'))
    print('forms:', len(forms), file=sys.stderr)

    with open(out_path, 'w', encoding='utf-8') as fh:
        fh.write('// Generated by tools/build-words.py — Greek KELLY list (ILSP/Athena RC, CC BY-NC 4.0)\n')
        fh.write('// with English glosses from Wiktionary via kaikki.org (CC BY-SA). Do not edit by hand.\n')
        fh.write('var WORDS = ' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')

    missing = [d for d in out if not d.get('e')]
    if '--missing' in sys.argv:
        for d in missing:
            print(d['w'] + '\t' + d.get('p', '') + '\t' + d.get('x', ''))
    print('words:', len(out), 'without gloss:', len(missing), file=sys.stderr)
    for lvl in LEVELS:
        n = sum(1 for d in out if d['l'] == lvl)
        m = sum(1 for d in missing if d['l'] == lvl)
        print(' ', lvl, n, 'missing', m, file=sys.stderr)


if __name__ == '__main__':
    main()
