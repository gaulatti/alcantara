import { ManagedMetricsService } from './managed-metrics.service';

describe('recipe metrics (gaulatti/alcantara#424)', () => {
  it('render bounded expansion and rebuild results, anything else as unknown', async () => {
    const metrics = new ManagedMetricsService();
    for (const result of [
      'ok',
      'issues',
      'issues',
      'rejected',
      'Fictional Song title',
    ])
      metrics.recordRecipeExpansion(result);
    for (const result of ['rebuilt', 'skipped', 'conflict', 'use_0123456789ab'])
      metrics.recordRecipeRebuild(result);
    for (const result of [
      'deleted',
      'refused_on_air',
      'refused_has_uses',
      'conflict',
      'e2e-222-check',
    ])
      metrics.recordRecipeDelete(result);
    const output = await metrics.render('');
    const samples = output
      .split('\n')
      .filter((line) =>
        /^alcantara_recipe_(expansions|rebuilds)_total\{/.test(line),
      )
      .sort();
    expect(samples).toEqual([
      'alcantara_recipe_expansions_total{result="issues"} 2',
      'alcantara_recipe_expansions_total{result="ok"} 1',
      'alcantara_recipe_expansions_total{result="rejected"} 1',
      'alcantara_recipe_expansions_total{result="unknown"} 1',
      'alcantara_recipe_rebuilds_total{result="conflict"} 1',
      'alcantara_recipe_rebuilds_total{result="rebuilt"} 1',
      'alcantara_recipe_rebuilds_total{result="skipped"} 1',
      'alcantara_recipe_rebuilds_total{result="unknown"} 1',
    ]);
    expect(output).toContain(
      '# TYPE alcantara_recipe_expansions_total counter',
    );
    expect(output).not.toContain('Fictional Song');
    expect(
      output
        .split('\n')
        .filter((line) => line.startsWith('alcantara_recipe_deletes_total{'))
        .sort(),
    ).toEqual([
      'alcantara_recipe_deletes_total{result="conflict"} 1',
      'alcantara_recipe_deletes_total{result="deleted"} 1',
      'alcantara_recipe_deletes_total{result="refused_has_uses"} 1',
      'alcantara_recipe_deletes_total{result="refused_on_air"} 1',
      'alcantara_recipe_deletes_total{result="unknown"} 1',
    ]);
    expect(output).not.toContain('e2e-222-check');
  });
});
