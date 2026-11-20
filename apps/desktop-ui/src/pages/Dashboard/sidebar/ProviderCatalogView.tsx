import { mountedDisclosure } from '@desktop/ws/sidebarMounted';
import { Fragment, useEffect, useMemo, useState, type FC } from 'react';
import { Tree, TreeChildren, TreeGroup, TreeRow } from '@desktop/components/SidebarTree';
import { StateHint } from '@desktop/pages/Dashboard/components/StateHint';
import type { ModelRow, Provider, ProviderType } from '@desktop/utils/api';
import { clearChipDragPayload, setChipDragPayload } from '@desktop/utils/nodeChip';
import { useProviderCatalog } from '../views/ProvidersView/ProviderCatalogContext';
import type { DetailSelection } from '../selection/types';
import { SidebarView } from './SidebarView';
import styles from './ProviderCatalogView.module.scss';

interface ProviderCatalogViewProps {
  onProviderOpen: (provider: Provider, model?: ModelRow) => void;
  activeProviderId?: string | null;
  activeModelId?: string | null;
}

type VisibleProviderType = Extract<ProviderType, 'llm' | 'integration'>;

interface ProviderSection {
  type: VisibleProviderType;
  label: string;
}

const SECTIONS: ProviderSection[] = [
  { type: 'llm', label: 'LLM' },
  { type: 'integration', label: 'Integrations' },
];

function providerSelection(provider: Provider, model?: ModelRow): DetailSelection {
  return {
    kind: 'provider',
    provider_id: provider.id,
    name: provider.name,
    provider_type: provider.type,
    focusModelId: model?.id,
  };
}

export const ProviderCatalogView: FC<ProviderCatalogViewProps> = ({
  onProviderOpen,
  activeProviderId = null,
  activeModelId = null,
}) => {
  const { providers, models, loading, error } = useProviderCatalog();
  const [openSections, setOpenSections] = useState<Record<VisibleProviderType, boolean>>({
    llm: true,
    integration: true,
  });
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({});

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.type !== 'runtime'),
    [providers]
  );
  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ModelRow[]>();
    for (const model of models) {
      const current = grouped.get(model.providerId);
      if (current) current.push(model);
      else grouped.set(model.providerId, [model]);
    }
    return grouped;
  }, [models]);

  useEffect(() => {
    if (!activeProviderId) return;
    const provider = visibleProviders.find((item) => item.id === activeProviderId);
    if (!provider || provider.type === 'runtime') return;
    setOpenSections((current) => ({ ...current, [provider.type]: true }));
    if (activeModelId) {
      setOpenProviders((current) => ({ ...current, [activeProviderId]: true }));
    }
  }, [activeModelId, activeProviderId, visibleProviders]);

  return (
    <SidebarView title="Providers">
      <Tree
        data-sidebar-mounted={loading ? 'loading' : error ? 'error' : 'ready'}
        aria-label="Providers and models"
      >
        {SECTIONS.map((section) => {
          const sectionProviders = visibleProviders.filter(
            (provider) => provider.type === section.type
          );
          return (
            <TreeGroup
              headerProps={{
                'data-sidebar-disclosure': '',
                ref: mountedDisclosure((open) =>
                  setOpenSections((prev) => ({ ...prev, [section.type]: open }))
                ),
              }}
              key={section.type}
              label={section.label}
              count={sectionProviders.length}
              open={openSections[section.type]}
              onToggle={() =>
                setOpenSections((current) => ({
                  ...current,
                  [section.type]: !current[section.type],
                }))
              }
            >
              {loading && sectionProviders.length === 0 ? (
                <StateHint>Loading providers…</StateHint>
              ) : sectionProviders.length === 0 ? (
                <div className={styles.empty}>No {section.label.toLowerCase()} providers.</div>
              ) : (
                sectionProviders.map((provider) => {
                  const providerModels = modelsByProvider.get(provider.id) ?? [];
                  const providerOpen = Boolean(openProviders[provider.id]);
                  return (
                    <Fragment key={provider.id}>
                      <TreeRow
                        depth={1}
                        data-sidebar-disclosure=""
                        aria-expanded={providerOpen}
                        data-inspect-id={provider.id}
                        data-inspect-name={provider.name}
                        ref={mountedDisclosure((open) =>
                          setOpenProviders((prev) => ({ ...prev, [provider.id]: open }))
                        )}
                        chevron={{
                          open: providerOpen,
                          onToggle: () =>
                            setOpenProviders((current) => ({
                              ...current,
                              [provider.id]: !current[provider.id],
                            })),
                          'aria-label': `${providerOpen ? 'Collapse' : 'Expand'} ${provider.name} models`,
                        }}
                        label={provider.name}
                        description={providerModels.length > 0 ? provider.id : undefined}
                        trailing={
                          providerModels.length > 0 ? (
                            <span className={styles.count}>{providerModels.length}</span>
                          ) : undefined
                        }
                        active={activeProviderId === provider.id && !activeModelId}
                        aria-selected={activeProviderId === provider.id && !activeModelId}
                        paneSelection={providerSelection(provider)}
                        onClick={() => onProviderOpen(provider)}
                        title={`Open ${provider.name}`}
                      />
                      {providerOpen && (
                        <TreeChildren guideLeft={42}>
                          {providerModels.length === 0 ? (
                            <div className={styles.empty}>No models discovered.</div>
                          ) : (
                            providerModels.map((model) => {
                              const selection = providerSelection(provider, model);
                              const title = model.displayName || model.modelId;
                              return (
                                <TreeRow
                                  key={model.id}
                                  depth={2}
                                  chevron="empty"
                                  className={styles.modelRow}
                                  data-inspect-id={model.id}
                                  icon={
                                    <span className={styles.modelIcon}>
                                      <span>M</span>
                                    </span>
                                  }
                                  label={title}
                                  description={model.modelId}
                                  active={activeModelId === model.id}
                                  aria-selected={activeModelId === model.id}
                                  paneSelection={selection}
                                  onClick={() => onProviderOpen(provider, model)}
                                  onDragStart={(event) =>
                                    setChipDragPayload(event, {
                                      chip: {
                                        id: model.modelId,
                                        kind: 'model',
                                        title,
                                      },
                                      dragLabel: `model: ${title}`,
                                      paneSelection: selection,
                                    })
                                  }
                                  onDragEnd={clearChipDragPayload}
                                  title={`${model.modelId} — drag into an input or code editor`}
                                />
                              );
                            })
                          )}
                        </TreeChildren>
                      )}
                    </Fragment>
                  );
                })
              )}
            </TreeGroup>
          );
        })}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </Tree>
    </SidebarView>
  );
};
