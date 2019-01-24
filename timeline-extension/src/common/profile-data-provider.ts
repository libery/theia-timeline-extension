import { FileResourceResolver } from '@theia/filesystem/lib/browser';
import URI from '@theia/core/lib/common/uri';

export type Log = { code: Array<Code>, ticks: Array<Ticks> }
export type Ticks = { tm: number, vm: number, s: Array<number> };
export type Code = { name: string, type: string, func?: number, kind?: string, tm?: number };
export type Stacks = Array<Array<number>>;
export type Names = Array<string>;

export class ProfileDataProvider {

    constructor(protected uri: string, protected readonly resourceResolver: FileResourceResolver) {
    }

    async getData() {
        console.log(window.location.hash);
        const uri = new URI(this.uri).withScheme('file');
        const resource = await this.resourceResolver.resolve(uri);
        const content = await resource.readContents();
        const json = JSON.parse(content);
        console.log("HEYHO", json);
        const namesAndStacks = this.v8logToStacks(json);
        console.log('stacks', namesAndStacks);
        const levels = this.mergeStacks(namesAndStacks.stacks);
        console.log('Levels', levels);


    }

    protected v8logToStacks(log: Log): { names: Names, stacks: Stacks } {
        const stacks = [];
        const names = [];
        const nameIds = new Map<string, number>();

        // find a common path in JS names (to make them shorter)
        let sharedPath: string = '';
        for (const code of log.code) {
            if (code && code.type === 'JS') {
                const matches = code.name.match(/\S* (\/\S+\/)/);
                if (matches) {
                    sharedPath = sharedPath ? this.getSharedStringPart(sharedPath, matches[1]) : matches[1];
                    if (!sharedPath) break;
                }
            }
        }

        for (const tick of log.ticks) {
            const stack = [];
            for (let i = tick.s.length; i >= 0; i -= 2) {
                const code = log.code[tick.s[i]];
                const name = this.codeToName(code, sharedPath);
                let nameId = nameIds.get(name);
                if (!nameId) {
                    nameId = names.length;
                    nameIds.set(name, nameId);
                    names.push(name);
                }
                stack.push(nameId);
            }
            stacks.push(stack);
        }
        return { names, stacks };
    }

    protected getSharedStringPart(str1: string, str2: string) {
        let common = '';
        const len = Math.min(str1.length, str2.length);
        for (let i = 0; i < len; i++) {
            if (str1[i] === str2[i]) common += str1[i];
            else break;
        }
        return common;
    }

    protected codeToName(code: Code, sharedPath: string) {
        if (!code || !code.type) return '(unknown)';

        let name = code.name;

        if (code.type === 'CPP') {
            const matches = name.match(/[tT] ([^(<]*)/);
            if (matches) name = matches[1];
            return '(C++) ' + name;
        }
        if (code.type === 'SHARED_LIB') return '(lib) ' + name;
        if (code.type === 'CODE') {
            if (
                code.kind === 'LoadIC' ||
                code.kind === 'StoreIC' ||
                code.kind === 'KeyedStoreIC' ||
                code.kind === 'KeyedLoadIC' ||
                code.kind === 'LoadGlobalIC' ||
                code.kind === 'Handler'
            ) return '(IC) ' + name;

            if (code.kind === 'BytecodeHandler') return '(bytecode) ~' + name;
            if (code.kind === 'Stub') return '(stub) ' + name;
            if (code.kind === 'Builtin') return '(builtin) ' + name;
            if (code.kind === 'RegExp') return '(regexp) ' + name;
        }
        if (code.type === 'JS') {
            if (sharedPath) name = name.replace(sharedPath, './');
            if (name[0] === ' ') name = '(anonymous)' + name;
            if (code.kind === 'Builtin' || code.kind === 'Unopt') return '~' + name;
            if (code.kind === 'Opt') return name;
        }

        return '(unknown)';
    }

    protected mergeStacks(stacks: Stacks) {
        // sort call stacks so that they can be merged top-down
        stacks.sort((a, b) => {
            const len = Math.min(a.length, b.length);
            for (let i = 0; i < len; i++) {
                const d = a[i] - b[i];
                if (d) return d;
            }
            const dlen = a.length - b.length;
            if (dlen) return dlen;

            return 0;
        });

        const levels:Array<Array<number>> = [];
        const queue = [0, 0, stacks.length - 1];

        // use a queue instead of recursion so that we don't hit max call stack limit
        while (queue.length) {
            const right = queue.pop() || 0;
            const left = queue.pop() || 0;
            const level = queue.pop() || 0;

            let i:number = left;

            while (i <= right) {
                const id = stacks[i][level];
                if (id === undefined) {
                    i++;
                    continue;
                }

                // find the range of adjacent blocks with the same name on the current stack level
                const start = i;
                let hasChildren = false;
                for (; i <= right && stacks[i][level] === id; i++) {
                    if (stacks[i].length > level + 1) hasChildren = true;
                }
                const end = i;

                if (hasChildren) {
                    queue.unshift(level + 1, start, end - 1);
                }

                levels[level] = levels[level] || [];
                levels[level].push(start, end - start, id);
            }
        }

        // delta-encode bar positions for smaller output
        for (const level of levels) {
            let prev = 0;
            for (let i = 0; i < level.length; i += 3) {
                const right = level[i] + level[i + 1];
                level[i] -= prev;
                prev = right;
            }
        }

        return levels;
    }
}