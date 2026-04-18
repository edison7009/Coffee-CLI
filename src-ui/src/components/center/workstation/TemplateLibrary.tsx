// TemplateLibrary — the "App Store homepage" view of Workstation.
//
// Users browse cards → click "Use this template" → a new TeamState gets
// instantiated on the canvas with the blueprint's structure and names,
// all nodes inactive. Pure presentational component; parent handles the
// actual team creation via onPick callback.

import { BLUEPRINTS } from './blueprints';
import type { Blueprint } from './types';

interface Props {
  onPick: (blueprint: Blueprint) => void;
}

export function TemplateLibrary({ onPick }: Props) {
  return (
    <div className="template-library">
      <div className="template-library-header">
        <h2 className="template-library-title">选择一个团队模板</h2>
        <p className="template-library-subtitle">
          模板只给你结构和岗位名称。激活每个卡片后，你自己决定用哪个 CLI 和配置。
        </p>
      </div>

      <div className="template-library-grid">
        {BLUEPRINTS.map(bp => (
          <div key={bp.id} className="template-card">
            <div className="template-card-icon">{bp.icon}</div>
            <div className="template-card-body">
              <div className="template-card-name">{bp.name}</div>
              <div className="template-card-desc">{bp.description}</div>
              <div className="template-card-meta">
                <span className="template-card-count">{bp.nodes.length} 个岗位</span>
                <span className="template-card-dot">·</span>
                <span className="template-card-author">{bp.author}</span>
              </div>
            </div>
            <button
              className="template-card-action"
              onClick={() => onPick(bp)}
            >
              使用此模板
            </button>
          </div>
        ))}

        <div className="template-card template-card--blank">
          <div className="template-card-icon">＋</div>
          <div className="template-card-body">
            <div className="template-card-name">从零开始</div>
            <div className="template-card-desc">
              空白画布。一个 Lead 节点开始，随手加岗位。
            </div>
          </div>
          <button
            className="template-card-action"
            onClick={() => onPick({
              id: 'custom',
              name: '自定义团队',
              icon: '✨',
              description: '从零开始搭建',
              author: 'you',
              nodes: [{ id: 'lead', name: 'Lead', position: { x: 240, y: 80 } }],
              edges: [],
            })}
          >
            空白画布
          </button>
        </div>
      </div>
    </div>
  );
}
