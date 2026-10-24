#!/usr/bin/env python3
# Generates src/game/daily_models.inc.h (in the sm64-port tree): for every (behavior, model id)
# pair SM64 ever spawns or switches to, the geo that model id means for that behavior.
#
# Model ids are per-level: 0x66 is the Moneybag in one enemy group, the Chain Chomp in another and
# Mr. I's iris in a third (include/model_ids.h). A course mixes objects from many levels, so an
# object that spawns a child (a hidden Moneybag spawns its Moneybag, a Boo cage its Boo) or switches
# its own model can find another level's model in that slot. daily.c looks the pair up here and
# loads the right geo into a free slot when the slot holds something else.
#
# Sources, all from the tree itself:
#   - spawn sites in src/game: any `MODEL_X, bhvY` argument pair (spawn_object*, try_to_spawn_object...);
#   - SPAWN_CHILD / SPAWN_OBJ in data/behavior_data.c;
#   - level scripts: OBJECT(MODEL_X, ..., bhvY), with the geo that level loads MODEL_X with;
#   - cur_obj_set_model(MODEL_X) / obj_has_model in a behavior file, credited to every behavior
#     whose script calls a function defined in that file.
# The geo for a spawn-site pair is the one model_ids.h names in its comment for MODEL_X.
#   python3 gen_models.py <sm64-port dir>
import re, glob, sys, os
root = sys.argv[1]
os.chdir(root)

geos, g2h = set(), {}
for h in sorted(glob.glob('actors/*.h')) + sorted(glob.glob('levels/*/header.h')):
    for g in re.findall(r'extern const GeoLayout (\w+)\[\]', open(h).read()): geos.add(g); g2h.setdefault(g, h)
behs = set(re.findall(r'^extern const BehaviorScript (bhv\w+)\[\]', open('include/behavior_data.h').read(), re.M))

# MODEL_X -> (id, geo named in its comment)
mid = {}
for name, val, rest in re.findall(r'^#define (MODEL_\w+)\s+(0x[0-9A-Fa-f]+|\d+)\b(.*)$', open('include/model_ids.h').read(), re.M):
    g = re.search(r'//\s*(\w+)', rest)
    mid[name] = (int(val, 0), g.group(1) if g and g.group(1) in geos else None)

pairs = set()   # (beh, model name, geo): a pair can mean several geos (one per level)
def add(beh, model, geo):
    if beh not in behs or model not in mid or geo is None or geo not in geos: return
    pairs.add((beh, model, geo))

# Level scripts: the geo each level (and each group script) loads a model with.
pat_geo = re.compile(r'LOAD_MODEL_FROM_GEO\(\s*(?:/\*\w+\*/\s*)?(\w+)\s*,\s*(?:/\*\w+\*/\s*)?(\w+)\s*\)')
pat_obj = re.compile(r'OBJECT(?:_WITH_ACTS)?\(\s*(?:/\*\w+\*/\s*)?(MODEL_\w+)\s*,.*?(bhv\w+)', re.S)
scripts_c = open('levels/scripts.c').read()
group_loads = {}
for m in re.finditer(r'const LevelScript (script_func_global_\d+)\[\] = \{(.*?)\n\};', scripts_c, re.S):
    group_loads[m.group(1)] = dict(pat_geo.findall(m.group(2)))
common = {}
for m in re.finditer(r'const LevelScript (level_main_scripts_entry|script_func_global_1)\[\] = \{(.*?)\n\};', scripts_c, re.S):
    common.update(pat_geo.findall(m.group(2)))
for lvl in sorted(glob.glob('levels/*/')):
    src = ''.join(open(f).read() for f in glob.glob(lvl + 'script.c') + glob.glob(lvl + 'areas/*/script.c'))
    if not src: continue
    loads = dict(common)
    for g in re.findall(r'JUMP_LINK\(\s*(script_func_global_\d+)\s*\)', src): loads.update(group_loads.get(g, {}))
    loads.update(pat_geo.findall(src))
    for model, beh in pat_obj.findall(src):
        if model in loads: add(beh, model, loads[model])

# Spawn sites and SPAWN_CHILD: the model's own (commented) geo.
srcs = glob.glob('src/game/*.c') + glob.glob('src/game/behaviors/*.c') + ['data/behavior_data.c']
for f in srcs:
    t = open(f).read()
    for model, beh in re.findall(r'(MODEL_\w+)\s*,\s*(?:/\*\w+\*/\s*)?(bhv\w+)', t):
        add(beh, model, mid[model][1] if model in mid else None)

# Model switches inside a behavior's own code.
bd = open('data/behavior_data.c').read()
beh_funcs = {}
for m in re.finditer(r'const BehaviorScript (bhv\w+)\[\] = \{(.*?)\n\};', bd, re.S):
    beh_funcs[m.group(1)] = set(re.findall(r'CALL_NATIVE\(\s*(\w+)\s*\)', m.group(2)))
for f in glob.glob('src/game/behaviors/*.inc.c'):
    t = open(f).read()
    defined = set(re.findall(r'^\w[\w\s\*]*?\b(\w+)\s*\([^;{]*\)\s*\{', t, re.M))
    switched = set(re.findall(r'(?:cur_obj_set_model|obj_has_model\s*\(\s*\w+\s*)\(?\s*,?\s*(MODEL_\w+)', t))
    switched |= set(re.findall(r'cur_obj_set_model\(\s*(MODEL_\w+)\s*\)', t))
    if not switched: continue
    for beh, fs in beh_funcs.items():
        if fs & defined:
            for model in switched: add(beh, model, mid[model][1] if model in mid else None)

# The inventory's own pieces (gen_lib.py): the geo each is loaded with.
for name, beh, geo, model in re.findall(r'\{ "(\w+)", (bhv\w+), (\w+), 0x[0-9A-Fa-f]+, \d, (MODEL_\w+), \d \}', open('src/game/daily_lib.inc.h').read()):
    add(beh, model, geo)
# Spawns whose model is a variable, not a MODEL_ argument (read off the source).
for beh, model in [('bhvPokeyBodyPart', 'MODEL_POKEY_HEAD')]:   # pokey.inc.c:155-166
    add(beh, model, mid[model][1])
rows = sorted(pairs)
with open('src/game/daily_models.inc.h', 'w') as o:
    o.write('// Generated by gen_models.py - do not edit. (behavior, model id) -> the geo it means there.\n')
    for h in sorted({g2h[g] for b, m, g in pairs}): o.write('#include "%s"\n' % h)
    o.write('struct ModelGeo { const BehaviorScript *beh; u8 model; const GeoLayout *geo; const char *name; };\n')
    o.write('static const struct ModelGeo sModelGeo[] = {\n')
    for beh, model, geo in rows:
        o.write('    { %s, %s, %s, "%s" },\n' % (beh, model, geo, beh[3:]))
    o.write('};\n#define NUM_MODEL_GEO ((s32) (sizeof(sModelGeo) / sizeof(sModelGeo[0])))\n')
print(len(rows), 'pairs')
