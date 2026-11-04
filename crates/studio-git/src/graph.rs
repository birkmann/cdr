//! Commit graph lane assignment for drawing a history graph.
//!
//! Rows correspond 1:1 to the commits passed to [`graph_lanes`] (which must be
//! ordered children before parents, as [`crate::log`] returns them). Each row
//! says in which lane (column) the commit's dot sits and which line segments
//! leave that row towards the next row. A UI draws, for every edge, a line
//! from `(from_lane, row)` to `(to_lane, row + 1)`; lanes are never compacted,
//! so a lane index is stable along a branch and can double as a colour index.

use serde::Serialize;

use crate::history::Commit;

/// Role of a graph edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    /// From the commit's dot towards its first parent.
    FirstParent,
    /// From a merge commit's dot towards a second or later parent.
    MergeParent,
    /// A line passing by this row without touching its dot.
    PassThrough,
}

/// A line segment from this row (`from_lane`) to the next row (`to_lane`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from_lane: usize,
    pub to_lane: usize,
    pub kind: EdgeKind,
}

/// Layout of one commit row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    /// Lane of this commit's dot.
    pub lane: usize,
    /// Lanes where lines arrive from the previous row (sorted, unique).
    pub lanes_in: Vec<usize>,
    /// Segments leaving this row towards the next one. The last row's edges
    /// point at parents that are not in the list (continue off-page).
    pub edges: Vec<GraphEdge>,
    /// Number of lanes needed to draw this row (max lane index + 1).
    pub width: usize,
}

/// Assigns lanes to `commits` (children before parents).
pub fn graph_lanes(commits: &[Commit]) -> Vec<GraphRow> {
    // lanes[i] = id of the commit the line in lane i is heading to.
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut rows = Vec::with_capacity(commits.len());
    let mut prev_targets: Vec<usize> = Vec::new();

    for (row, c) in commits.iter().enumerate() {
        let lane = match lanes.iter().position(|l| l.as_deref() == Some(&c.id)) {
            Some(i) => i,
            None => alloc(&mut lanes),
        };
        // Every lane heading for this commit ends here.
        for l in lanes.iter_mut() {
            if l.as_deref() == Some(&c.id) {
                *l = None;
            }
        }
        let passing: Vec<usize> = (0..lanes.len()).filter(|i| lanes[*i].is_some()).collect();

        // (lane in the state after this row, kind)
        let mut node_edges: Vec<(usize, EdgeKind)> = Vec::new();
        for (pi, parent) in c.parents.iter().enumerate() {
            let kind = if pi == 0 {
                EdgeKind::FirstParent
            } else {
                EdgeKind::MergeParent
            };
            if let Some(k) = lanes.iter().position(|l| l.as_deref() == Some(parent)) {
                node_edges.push((k, kind));
            } else {
                let k = if pi == 0 && lanes[lane].is_none() {
                    lane
                } else {
                    alloc(&mut lanes)
                };
                lanes[k] = Some(parent.clone());
                node_edges.push((k, kind));
            }
        }

        // Where the next commit's dot will be; lines heading to it converge there.
        let next_lane = commits.get(row + 1).map(|n| {
            lanes
                .iter()
                .position(|l| l.as_deref() == Some(&n.id))
                .unwrap_or(usize::MAX)
        });
        let target = |k: usize, lanes: &Vec<Option<String>>| -> usize {
            match (next_lane, commits.get(row + 1)) {
                (Some(nl), Some(n)) if nl != usize::MAX && lanes[k].as_deref() == Some(&n.id) => nl,
                _ => k,
            }
        };

        let mut edges = Vec::new();
        for &k in &passing {
            edges.push(GraphEdge {
                from_lane: k,
                to_lane: target(k, &lanes),
                kind: EdgeKind::PassThrough,
            });
        }
        for &(k, kind) in &node_edges {
            edges.push(GraphEdge {
                from_lane: lane,
                to_lane: target(k, &lanes),
                kind,
            });
        }

        while lanes.last().is_some_and(|l| l.is_none()) {
            lanes.pop();
        }

        let mut lanes_in = std::mem::take(&mut prev_targets);
        lanes_in.sort_unstable();
        lanes_in.dedup();
        prev_targets = edges.iter().map(|e| e.to_lane).collect();

        let width = edges
            .iter()
            .flat_map(|e| [e.from_lane, e.to_lane])
            .chain(lanes_in.iter().copied())
            .chain([lane])
            .max()
            .unwrap_or(0)
            + 1;
        rows.push(GraphRow {
            lane,
            lanes_in,
            edges,
            width,
        });
    }
    rows
}

fn alloc(lanes: &mut Vec<Option<String>>) -> usize {
    match lanes.iter().position(|l| l.is_none()) {
        Some(i) => i,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, parents: &[&str]) -> Commit {
        Commit {
            id: id.into(),
            short_id: id.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author_name: String::new(),
            author_email: String::new(),
            author_time: 0,
            committer_time: 0,
            subject: String::new(),
            body: String::new(),
            refs: Vec::new(),
        }
    }

    fn e(from: usize, to: usize, kind: EdgeKind) -> GraphEdge {
        GraphEdge {
            from_lane: from,
            to_lane: to,
            kind,
        }
    }

    #[test]
    fn linear_history_uses_one_lane() {
        let rows = graph_lanes(&[c("c", &["b"]), c("b", &["a"]), c("a", &[])]);
        assert!(rows.iter().all(|r| r.lane == 0 && r.width == 1));
        assert_eq!(rows[0].edges, vec![e(0, 0, EdgeKind::FirstParent)]);
        assert!(rows[2].edges.is_empty());
        assert_eq!(rows[1].lanes_in, vec![0]);
    }

    #[test]
    fn merge_history() {
        // m merges c (main) and d (feature); both branch off b.
        //  m
        //  |\
        //  c |
        //  | d
        //  |/
        //  b
        //  a
        let commits = [
            c("m", &["c", "d"]),
            c("c", &["b"]),
            c("d", &["b"]),
            c("b", &["a"]),
            c("a", &[]),
        ];
        let rows = graph_lanes(&commits);
        let lanes: Vec<usize> = rows.iter().map(|r| r.lane).collect();
        assert_eq!(lanes, vec![0, 0, 1, 0, 0]);
        assert_eq!(
            rows[0].edges,
            vec![
                e(0, 0, EdgeKind::FirstParent),
                e(0, 1, EdgeKind::MergeParent)
            ]
        );
        assert_eq!(
            rows[1].edges,
            vec![
                e(1, 1, EdgeKind::PassThrough),
                e(0, 0, EdgeKind::FirstParent)
            ]
        );
        assert_eq!(rows[1].lanes_in, vec![0, 1]);
        // d's line converges back into lane 0 where b sits.
        assert_eq!(
            rows[2].edges,
            vec![
                e(0, 0, EdgeKind::PassThrough),
                e(1, 0, EdgeKind::FirstParent)
            ]
        );
        assert_eq!(rows[3].lanes_in, vec![0]);
        assert_eq!(rows[3].edges, vec![e(0, 0, EdgeKind::FirstParent)]);
        assert_eq!(rows[0].width, 2);
        assert_eq!(rows[4].width, 1);
    }

    #[test]
    fn independent_heads_and_reuse() {
        // Two branch tips x and y, y's branch joins x's at b.
        let commits = [c("x", &["b"]), c("y", &["b"]), c("b", &[])];
        let rows = graph_lanes(&commits);
        assert_eq!(rows[0].lane, 0);
        assert_eq!(rows[1].lane, 1);
        assert_eq!(
            rows[1].edges,
            vec![
                e(0, 0, EdgeKind::PassThrough),
                e(1, 0, EdgeKind::FirstParent)
            ]
        );
        assert_eq!(rows[2].lane, 0);
        assert_eq!(rows[2].lanes_in, vec![0]);
    }

    #[test]
    fn octopus_and_offpage_parents() {
        let rows = graph_lanes(&[c("m", &["p1", "p2", "p3"])]);
        assert_eq!(rows[0].edges.len(), 3);
        assert_eq!(rows[0].width, 3);
    }
}
