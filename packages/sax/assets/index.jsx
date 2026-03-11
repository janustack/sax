export default function Example({ user, items, onSelect }) {
	const isAdmin = user?.role === "admin";

	return (
		<>
			<header className="header">
				<h1>Hello, {user?.name ?? "Guest"}!</h1>

				{/* boolean attribute + string attribute */}
				<button disabled={!isAdmin} type="button">
					Admin Action
				</button>

				{/* JSX attribute expression */}
				<div data-meta={{ id: user?.id, role: user?.role }}>Meta container</div>

				{/* ternary with nested tags */}
				{isAdmin ? <span className="badge">ADMIN</span> : <span>USER</span>}
			</header>

			<main>
				<ul>
					{items.map((item) => (
						<li key={item.id}>
							{/* unquoted attribute value (HTML-ish; not recommended in JSX, but shown as a test) */}
							<a
								href={item.href}
								data-id={item.id}
								onClick={() => onSelect(item)}
							>
								{item.label}
							</a>
						</li>
					))}
				</ul>

				{/* self-closing tag */}
				<img src="/logo.png" alt="Logo" />
			</main>
		</>
	);
}
