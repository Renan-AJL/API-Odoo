import json

with open('/home/z/my-project/API-Odoo/te-spec.json') as f:
    spec = json.load(f)

paths = spec.get('paths', {})
for path, methods in paths.items():
    if 'motorista' in path.lower() or 'driver' in path.lower():
        print(f'\n=== {path} ===')
        for method, details in methods.items():
            print(f'  {method.upper()}: {details.get("summary", "")}')
            params = details.get('parameters', [])
            for p in params:
                print(f'    param: {p.get("name", "")} ({p.get("in", "")})')
            body_param = details.get('parameters', [{}])

print('\n\n=== ALL PATHS ===')
for path in sorted(paths.keys()):
    for method in paths[path]:
        summary = paths[path][method].get('summary', '')
        print(f'{method.upper():6s} {path:50s} {summary}')
