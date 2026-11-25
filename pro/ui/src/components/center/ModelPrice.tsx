import { useEffect } from 'react';
import { useT } from '../../i18n/useT';
import { modelPrice, refreshModelPrices } from '../../lib/model-prices';

const usd = (value: number) => `$${Number(value.toFixed(value < 1 ? 3 : 2))}`;

/**
 * A model's list price inside a model menu row's note, per million input / output tokens: " · $3/$15". The row is one
 * line, so the figures stay terse and the full wording is for screen readers. Nothing for a model with no price.
 */
export function ModelPrice({ model }: { model: string | undefined }) {
  const t = useT();
  useEffect(() => { void refreshModelPrices(); }, []);
  const price = modelPrice(model);
  if (!price) return null;
  const input = usd(price.input), output = usd(price.output);
  return <span className="model-price" aria-label={t('model.price', { input, output })}> · {input}/{output}</span>;
}
