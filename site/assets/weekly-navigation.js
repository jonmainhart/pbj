function viewFor(entity) {
    return entity.kind === "player" ? "players" : "games";
}

export function openEntity(state, target) {
    return { view: viewFor(target), active: target, returnTo: null };
}

export function crossNavigate(state, target) {
    return {
        view: viewFor(target),
        active: target,
        returnTo: state.returnTo === null ? state.active : null,
    };
}

export function closeEntity(state) {
    return state.returnTo === null
        ? { ...state, active: null }
        : { view: viewFor(state.returnTo), active: state.returnTo, returnTo: null };
}
