type AppMethod = (event: Event) => void;
interface AppOptions {
    element?: HTMLElement;
    componentName?: string | null;
    data?: Record<string, unknown>;
    methods?: Record<string, AppMethod>;
}
export default class App {
    #private;
    readonly componentName: string;
    readonly data: Record<string, unknown>;
    readonly element: HTMLElement;
    readonly methods: Readonly<Record<string, AppMethod>>;
    readonly ready: Promise<void>;
    constructor({ element, componentName, data, methods }?: AppOptions);
    static clearTemplateCache(): void;
    static loadTemplate(templateName: string): Promise<string>;
}
export {};
