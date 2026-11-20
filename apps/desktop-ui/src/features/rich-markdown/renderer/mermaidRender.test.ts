import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mock }));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>Chart</text></svg>';

beforeEach(() => {
  vi.resetModules();
  mock.initialize.mockReset();
  mock.render.mockReset().mockResolvedValue({ svg });
});

describe('renderMermaid', () => {
  it('uses strict configuration and an isolated image with temporary DOM cleanup', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    mock.render.mockImplementation(async (_id, _source, host: HTMLElement) => {
      expect(host.isConnected).toBe(true);
      return { svg };
    });
    const result = await renderMermaid('graph TD; A-->B');
    expect(mock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
        suppressErrorRendering: true,
        htmlLabels: false,
        maxEdges: 500,
      })
    );
    expect(result.src).toMatch(/^data:image\/svg\+xml/);
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('cleans up failed renders and continues processing later diagrams', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    mock.render.mockRejectedValueOnce(new Error('syntax'));
    await expect(renderMermaid('broken')).rejects.toThrow('syntax');
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
    await expect(renderMermaid('graph TD; A-->B')).resolves.toMatchObject({
      src: expect.stringMatching(/^data:/),
    });
    expect(mock.initialize).toHaveBeenCalledTimes(1);
  });

  it('reports the diagram size from its viewBox, and none without one', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    mock.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="-8 -8 640 320"></svg>',
    });
    await expect(renderMermaid('graph TD; A-->B')).resolves.toMatchObject({
      size: { width: 640, height: 320 },
    });
    mock.render.mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    await expect(renderMermaid('graph TD; A-->B')).resolves.toMatchObject({ size: null });
  });

  it('measures every node and its label text in natural pixels and hides the text of chip labels', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    mock.render.mockResolvedValueOnce({
      svg:
        '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="-8 -8 200 100">' +
        '<g class="node default" id="n-A"><rect/><g class="label"><text id="t-A">' +
        '<tspan class="text-outer-tspan">Release</tspan>' +
        '<tspan class="text-outer-tspan">plan\u2060</tspan></text></g></g>' +
        '<g class="node default" id="n-B"><g class="label"><text id="t-B">Next  step</text></g></g>' +
        '</svg>',
    });
    // jsdom has no layout: the svg sits at (100, 50), drawn at 2× (400 px for
    // a 200-unit viewBox), so every node rect divides by 2 after the offset.
    const rects: Record<string, DOMRect> = {
      svg: new DOMRect(100, 50, 400, 200),
      'n-A': new DOMRect(120, 70, 100, 40),
      't-A': new DOMRect(130, 80, 80, 20),
      'n-B': new DOMRect(300, 150, 60, 30),
      't-B': new DOMRect(305, 155, 50, 20),
    };
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return rects[this.localName === 'svg' ? 'svg' : this.id] ?? new DOMRect();
    });
    const result = await renderMermaid('graph TD; A-->B', undefined, {
      chipLabels: ['Release plan\u2060'],
    });
    spy.mockRestore();
    expect(result.nodes).toEqual([
      { label: 'Release plan\u2060', box: { x: 10, y: 10, width: 50, height: 20 }, labelWidth: 40 },
      { label: 'Next step', box: { x: 100, y: 50, width: 30, height: 15 }, labelWidth: 25 },
    ]);
    const svgText = decodeURIComponent(result.src.slice(result.src.indexOf(',') + 1));
    const image = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const [chipText, plainText] = Array.from(image.querySelectorAll('text'));
    expect(chipText?.getAttribute('style')).toContain('visibility:hidden');
    expect(plainText?.getAttribute('style')).toBeNull();
    // The measuring copy never stays in the page.
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('measures no nodes without a viewBox size or without layout', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    const node = '<g class="node"><text>A</text></g>';
    mock.render.mockResolvedValueOnce({
      svg: `<svg xmlns="http://www.w3.org/2000/svg">${node}</svg>`,
    });
    await expect(renderMermaid('graph TD; A')).resolves.toMatchObject({ nodes: [] });
    mock.render.mockResolvedValueOnce({
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${node}</svg>`,
    });
    await expect(renderMermaid('graph TD; A')).resolves.toMatchObject({ nodes: [] });
  });

  it('wraps labels later in a chart with chips, and pins the 120px least node width', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    const wrapOf = (call: number) => mock.initialize.mock.calls[call]?.[0]?.flowchart;
    await renderMermaid('graph TD; A-->B');
    await renderMermaid('graph TD; A-->B', undefined, { chipLabels: ['Spec\u2060'] });
    await renderMermaid('graph TD; A-->B', undefined, { chipLabels: ['Spec\u2060'] });
    await renderMermaid('graph TD; A-->B');
    expect(mock.initialize).toHaveBeenCalledTimes(3);
    const flowchart = (wrappingWidth: number) => ({
      htmlLabels: false,
      wrappingWidth,
      minNodeWidth: 120,
    });
    expect(wrapOf(0)).toEqual(flowchart(120));
    expect(wrapOf(1)).toEqual(flowchart(240));
    expect(wrapOf(2)).toEqual(flowchart(120));
    expect(mock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ securityLevel: 'strict', htmlLabels: false })
    );
  });

  it('rejects malformed SVG instead of displaying a broken image', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    mock.render.mockResolvedValueOnce({ svg: '<svg><broken>' });
    await expect(renderMermaid('graph TD; A-->B')).rejects.toThrow('malformed SVG');
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('serializes renders and skips obsolete queued requests', async () => {
    const { renderMermaid } = await import('./mermaidRender');
    let finish!: (value: { svg: string }) => void;
    mock.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = renderMermaid('first');
    await vi.waitFor(() => expect(mock.render).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const obsolete = renderMermaid('old', controller.signal);
    const rejected = expect(obsolete).rejects.toThrow();
    controller.abort();
    const last = renderMermaid('last');
    finish({ svg });
    await first;
    await rejected;
    await last;
    expect(mock.render.mock.calls.map((call) => call[1])).toEqual(['first', 'last']);
  });
});

describe('mermaidLabelKey', () => {
  it('ignores the whitespace Mermaid adds or drops when it wraps a label', async () => {
    const { mermaidLabelKey } = await import('./mermaidRender');
    expect(mermaidLabelKey(' A rather  long\ntitle ')).toBe(mermaidLabelKey('A rather longtitle'));
    expect(mermaidLabelKey('doc-11111 11-aaa\u2060')).toBe('doc-1111111-aaa\u2060');
  });
});
