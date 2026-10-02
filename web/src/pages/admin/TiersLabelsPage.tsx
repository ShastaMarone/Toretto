import type { Label, Tier } from '@shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Layers, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../api/client';
import { keys, useLabels, useTiers } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { Field, FormError, Input, Select } from '../../components/ui/Form';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import {
  Card,
  ColorPicker,
  EmptyState,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
} from '../../components/ui/Misc';
import { alpha, PALETTE } from '../../lib/colors';
import { fieldErrors, formMessage } from '../../lib/forms';

type Editing =
  | { kind: 'tier'; tier: Tier | null }
  | { kind: 'label'; label: Label | null; tierId: string | null }
  | { kind: 'delete-tier'; tier: Tier }
  | { kind: 'delete-label'; label: Label };

export default function TiersLabelsPage() {
  const tiers = useTiers();
  const labels = useLabels();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.tiers });
    void queryClient.invalidateQueries({ queryKey: keys.labels });
    void queryClient.invalidateQueries({ queryKey: ['schedule'] });
    void queryClient.invalidateQueries({ queryKey: ['team'] });
  };
  const removeTier = useMutation({
    mutationFn: (tier: Tier) => api.delete(`/tiers/${tier.id}`),
    onSuccess: () => {
      toast.success('Tier deleted');
      setEditing(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const removeLabel = useMutation({
    mutationFn: (label: Label) => api.delete(`/labels/${label.id}`),
    onSuccess: () => {
      toast.success('Label deleted');
      setEditing(null);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  if (tiers.isLoading || labels.isLoading) return <LoadingBlock />;
  if (tiers.isError || labels.isError) return <ErrorBlock error={tiers.error ?? labels.error} />;
  const all = labels.data ?? [];
  const globalLabels = all.filter((l) => l.tierId === null);

  return (
    <>
      <PageHeader
        title="Tiers & labels"
        description="Tiers group people on the schedule and color their shifts. Labels (On-Call, Training, Overtime…) tag shifts — make them for one tier or for everyone."
        actions={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setEditing({ kind: 'tier', tier: null })}
          >
            Add tier
          </Button>
        }
      />
      {tiers.data?.length === 0 && (
        <Card className="mb-6">
          <EmptyState
            icon={<Layers />}
            title="No tiers yet"
            description="Create a tier (e.g. Tier 1) to start scheduling."
          />
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {tiers.data?.map((tier) => {
          const own = all.filter((l) => l.tierId === tier.id);
          return (
            <Card key={tier.id} className="flex flex-col">
              <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
                <span
                  className="size-9 shrink-0 rounded-lg"
                  style={{ backgroundColor: tier.color }}
                />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold text-slate-900">{tier.name}</h2>
                  <p className="text-xs text-slate-500">
                    {tier.memberCount} {tier.memberCount === 1 ? 'person' : 'people'}
                    {tier.unpaidBreakMinutes > 0 && ` · ${tier.unpaidBreakMinutes}m unpaid break`}
                  </p>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit ${tier.name}`}
                  onClick={() => setEditing({ kind: 'tier', tier })}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${tier.name}`}
                  onClick={() => setEditing({ kind: 'delete-tier', tier })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="flex-1 px-5 py-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Labels for {tier.name}
                </p>
                <LabelList
                  labels={own}
                  onEdit={(label) => setEditing({ kind: 'label', label, tierId: tier.id })}
                />
                {own.length === 0 && <p className="text-sm text-slate-400">No tier-only labels.</p>}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="size-4" />}
                  className="-ml-2 mt-2"
                  onClick={() => setEditing({ kind: 'label', label: null, tierId: tier.id })}
                >
                  Add label
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <Card className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="font-semibold text-slate-900">Labels for every tier</h2>
            <p className="text-sm text-slate-500">Available for everyone, in any tier.</p>
          </div>
          <Button
            size="sm"
            icon={<Plus className="size-4" />}
            onClick={() => setEditing({ kind: 'label', label: null, tierId: null })}
          >
            Add label
          </Button>
        </div>
        <div className="px-5 py-4">
          {globalLabels.length ? (
            <LabelList
              labels={globalLabels}
              onEdit={(label) => setEditing({ kind: 'label', label, tierId: null })}
            />
          ) : (
            <p className="text-sm text-slate-400">No shared labels.</p>
          )}
        </div>
      </Card>

      {editing?.kind === 'tier' && (
        <TierDialog tier={editing.tier} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {editing?.kind === 'label' && (
        <LabelDialog
          label={editing.label}
          tierId={editing.tierId}
          tiers={tiers.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          onDelete={
            editing.label
              ? () => setEditing({ kind: 'delete-label', label: editing.label! })
              : undefined
          }
        />
      )}
      {editing?.kind === 'delete-tier' && (
        <ConfirmDialog
          title={`Delete ${editing.tier.name}?`}
          confirmLabel="Delete tier"
          danger
          loading={removeTier.isPending}
          onConfirm={() => removeTier.mutate(editing.tier)}
          onClose={() => setEditing(null)}
        >
          Its labels are deleted too. A tier can only be deleted once no one is in it and none of
          its labels are used on shifts — otherwise, rename it instead.
        </ConfirmDialog>
      )}
      {editing?.kind === 'delete-label' && (
        <ConfirmDialog
          title={`Delete “${editing.label.name}”?`}
          confirmLabel="Delete label"
          danger
          loading={removeLabel.isPending}
          onConfirm={() => removeLabel.mutate(editing.label)}
          onClose={() => setEditing(null)}
        >
          {editing.label.shiftCount
            ? `${editing.label.shiftCount} shift${editing.label.shiftCount === 1 ? '' : 's'} use this label and will become unlabeled.`
            : 'No shifts use this label.'}
        </ConfirmDialog>
      )}
    </>
  );
}

function LabelList({ labels, onEdit }: { labels: Label[]; onEdit: (label: Label) => void }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {labels.map((l) => (
        <li key={l.id}>
          <button
            type="button"
            onClick={() => onEdit(l)}
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-medium text-slate-800 transition hover:shadow-sm"
            style={{ backgroundColor: alpha(l.color, 0.1), borderColor: alpha(l.color, 0.5) }}
            title={`${l.shiftCount} shift${l.shiftCount === 1 ? '' : 's'} · click to edit`}
          >
            <Tag className="size-3.5" style={{ color: l.color }} />
            {l.name}
            <span className="text-xs font-normal text-slate-500">{l.shiftCount}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TierDialog({
  tier,
  onClose,
  onSaved,
}: {
  tier: Tier | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tier?.name ?? '');
  const [color, setColor] = useState(tier?.color ?? PALETTE[0]!);
  const [unpaidBreak, setUnpaidBreak] = useState(String(tier?.unpaidBreakMinutes ?? 0));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        color,
        unpaidBreakMinutes: Math.max(0, Math.min(240, Math.round(Number(unpaidBreak) || 0))),
      };
      return tier ? api.patch<Tier>(`/tiers/${tier.id}`, body) : api.post<Tier>('/tiers', body);
    },
    onSuccess: () => {
      toast.success(tier ? 'Tier saved' : 'Tier created');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      title={tier ? `Edit ${tier.name}` : 'Add tier'}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={formMessage(save.error, ['name'])} />
        <Field label="Name" error={fieldErrors(save.error).name}>
          <Input
            required
            autoFocus
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Tier 1"
          />
        </Field>
        <Field
          label="Unpaid break (minutes)"
          hint="Taken off each shift longer than 5 hours when counting hours and overtime. For example, 60 makes a 9-hour shift count as 8. Use 0 for none."
          error={fieldErrors(save.error).unpaidBreakMinutes}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            step={5}
            value={unpaidBreak}
            onChange={(e) => setUnpaidBreak(e.target.value)}
          />
        </Field>
        <ColorPicker value={color} onChange={setColor} />
      </div>
    </Modal>
  );
}

function LabelDialog({
  label,
  tierId,
  tiers,
  onClose,
  onSaved,
  onDelete,
}: {
  label: Label | null;
  tierId: string | null;
  tiers: Tier[];
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState(label?.color ?? PALETTE[8]!);
  const [scope, setScope] = useState(label?.tierId ?? tierId ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = { name, color, tierId: scope || null };
      return label
        ? api.patch<Label>(`/labels/${label.id}`, body)
        : api.post<Label>('/labels', body);
    },
    onSuccess: () => {
      toast.success(label ? 'Label saved' : 'Label created');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      title={label ? `Edit “${label.name}”` : 'Add label'}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      size="sm"
      footer={
        <>
          {onDelete && (
            <Button
              variant="danger-ghost"
              className="mr-auto"
              icon={<Trash2 className="size-4" />}
              onClick={onDelete}
            >
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={formMessage(save.error, ['name'])} />
        <Field label="Name" error={fieldErrors(save.error).name}>
          <Input
            required
            autoFocus
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. On-Call"
          />
        </Field>
        <Field label="Available on">
          <Select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Every tier</option>
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} only
              </option>
            ))}
          </Select>
        </Field>
        <ColorPicker value={color} onChange={setColor} />
      </div>
    </Modal>
  );
}
